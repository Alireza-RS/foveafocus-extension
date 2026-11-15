/**
 * The bridge between Obsidian's PDF view and the PDF reading pipeline.
 *
 * Three jobs: know which PDF the commands are about, remember where the reader last
 * selected or clicked in it (the command palette takes the selection away before a command
 * can look at it), and hand out the parsed narrative of a PDF, parsing each file once.
 */

import { FileView, loadPdfJs, type App, type Plugin, type TFile, type WorkspaceLeaf } from 'obsidian';
import { parsePdf, readSelectionAnchors, type PdfDocumentLike, type PdfFilterOptions, type PdfNarrative, type SelectionAnchors } from './pdf';

/** A selection in a PDF view, with the file it was made in and when. */
export interface PdfSelection extends SelectionAnchors {
  filePath: string;
  at: number;
}

/** The parts of Obsidian's PDF view that are used here. None of them is public API, so every one may be missing. */
interface PdfViewInternals {
  viewer?: {
    child?: {
      file?: TFile | null;
      pdfViewer?: {
        pdfDocument?: PdfDocumentLike | null;
        pdfViewer?: { pdfDocument?: PdfDocumentLike | null } | null;
      } | null;
    } | null;
  } | null;
}

interface PdfJsLib {
  getDocument(source: { data: ArrayBuffer }): { promise: Promise<PdfDocumentLike>; destroy(): Promise<void> };
}

/** How long a PDF leaf still counts as the active one after focus has left it for the command palette. */
const LEAF_GRACE_MS = 4000;
/** How long a selection is remembered once it is no longer on screen. */
const SELECTION_MEMORY_MS = 20000;
/** Parsed PDFs kept in memory. */
const CACHE_SIZE = 3;

export class PdfViewIntegration {
  private lastLeaf: WorkspaceLeaf | null = null;
  private lastLeafAt = 0;
  private remembered: PdfSelection | null = null;
  /** What the pointer last went down on inside a PDF view. */
  private pressed: Node | null = null;
  private captureFrame: number | null = null;
  private narratives = new Map<string, { key: string; narrative: Promise<PdfNarrative> }>();

  constructor(private app: App, private plugin: Plugin) {}

  /** Start following the active leaf and the selection. Call once, from onload. */
  public start(): void {
    this.plugin.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => this.noteLeaf(leaf)));
    this.noteLeaf(this.app.workspace.getActiveViewOfType(FileView)?.leaf ?? null);

    this.watchSelection(document);
    this.plugin.registerEvent(this.app.workspace.on('window-open', (_, win) => this.watchSelection(win.document)));
  }

  private noteLeaf(leaf: WorkspaceLeaf | null): void {
    if (leaf?.view.getViewType() !== 'pdf') return;
    this.lastLeaf = leaf;
    this.lastLeafAt = Date.now();
  }

  /** The PDF view the user is in, or was in a moment ago when a command took the focus. */
  public activePdfLeaf(): WorkspaceLeaf | null {
    const active = this.app.workspace.getActiveViewOfType(FileView)?.leaf ?? null;
    if (active?.view.getViewType() === 'pdf') {
      this.noteLeaf(active);
      return active;
    }
    const recent = this.lastLeaf && Date.now() - this.lastLeafAt < LEAF_GRACE_MS && this.lastLeaf.view.getViewType() === 'pdf';
    return recent ? this.lastLeaf : null;
  }

  public fileOf(leaf: WorkspaceLeaf): TFile | null {
    // A leaf that is reused for another PDF can keep its old `view.file` for a while; the
    // viewer inside it knows better.
    const inner = (leaf.view as unknown as PdfViewInternals).viewer?.child?.file;
    const file = inner ?? (leaf.view as FileView).file;
    return file?.extension?.toLowerCase() === 'pdf' ? file : null;
  }

  // ------------------------------------------------------------------------------------
  // Selection
  // ------------------------------------------------------------------------------------

  private watchSelection(doc: Document): void {
    this.plugin.registerDomEvent(doc, 'pointerdown', (event) => {
      const target = event.target as Node | null;
      if (this.leafHolding(target)) this.pressed = target;
    }, true);
    this.plugin.registerDomEvent(doc, 'selectionchange', () => {
      if (this.captureFrame !== null) return;
      this.captureFrame = window.requestAnimationFrame(() => {
        this.captureFrame = null;
        this.capture(doc);
      });
    });
  }

  private leafHolding(node: Node | null): WorkspaceLeaf | null {
    if (!node) return null;
    return this.app.workspace.getLeavesOfType('pdf').find((leaf) => leaf.view.containerEl.contains(node)) ?? null;
  }

  private read(doc: Document): PdfSelection | 'cleared' | null {
    const selection = doc.getSelection();
    const leaf = this.leafHolding(selection?.anchorNode ?? null);
    const file = leaf && this.fileOf(leaf);
    // A selection somewhere else (the command palette, another pane) says nothing about the PDF.
    if (!selection || !file) return null;
    const anchors = readSelectionAnchors(selection, this.pressed);
    // A click on an empty part of the page is the user putting the selection away.
    return anchors ? { ...anchors, filePath: file.path, at: Date.now() } : 'cleared';
  }

  private capture(doc: Document): void {
    const now = this.read(doc);
    if (now === 'cleared') this.remembered = null;
    else if (now) this.remembered = now;
  }

  /** The selection or caret in the given PDF: what is on screen now, else what was there a moment ago. */
  public selectionIn(file: TFile): PdfSelection | null {
    for (const doc of new Set(this.app.workspace.getLeavesOfType('pdf').map((leaf) => leaf.view.containerEl.ownerDocument))) {
      const live = this.read(doc);
      if (live && live !== 'cleared' && live.filePath === file.path) return live;
    }
    const kept = this.remembered;
    return kept && kept.filePath === file.path && Date.now() - kept.at < SELECTION_MEMORY_MS ? kept : null;
  }

  // ------------------------------------------------------------------------------------
  // Narrative
  // ------------------------------------------------------------------------------------

  /** The document the viewer already has open, when that viewer is showing `file`. */
  private openDocument(file: TFile): PdfDocumentLike | null {
    for (const leaf of this.app.workspace.getLeavesOfType('pdf')) {
      if (this.fileOf(leaf)?.path !== file.path) continue;
      const viewer = (leaf.view as unknown as PdfViewInternals).viewer?.child?.pdfViewer;
      const doc = viewer?.pdfViewer?.pdfDocument ?? viewer?.pdfDocument;
      if (doc?.numPages) return doc;
    }
    return null;
  }

  private async parse(file: TFile, filters: PdfFilterOptions): Promise<PdfNarrative> {
    // Reading through the viewer's own document costs no second load of the file, and it is
    // what makes a selection line up exactly: the text layer is built from the same runs.
    const open = this.openDocument(file);
    if (open) return parsePdf(open, filters);

    const pdfjs = (await loadPdfJs()) as PdfJsLib;
    const task = pdfjs.getDocument({ data: await this.app.vault.readBinary(file) });
    try {
      return await parsePdf(await task.promise, filters);
    } finally {
      void task.destroy();
    }
  }

  /** The narrative of a PDF under the given filters. Parsed on first use, then kept until the file or the filters change. */
  public narrativeOf(file: TFile, filters: PdfFilterOptions): Promise<PdfNarrative> {
    const key = `${file.stat.mtime}:${file.stat.size}:${JSON.stringify(filters)}`;
    const cached = this.narratives.get(file.path);
    if (cached?.key === key) return cached.narrative;

    const narrative = this.parse(file, filters);
    this.narratives.delete(file.path);
    this.narratives.set(file.path, { key, narrative });
    for (const path of this.narratives.keys()) {
      if (this.narratives.size <= CACHE_SIZE) break;
      this.narratives.delete(path);
    }
    // A failed parse must not be remembered as the answer.
    narrative.catch(() => {
      if (this.narratives.get(file.path)?.narrative === narrative) this.narratives.delete(file.path);
    });
    return narrative;
  }
}
