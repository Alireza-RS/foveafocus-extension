import { Editor, MarkdownView, Menu, Notice, Plugin, TFile } from 'obsidian';
import { FoveaFocusModal } from './src/rsvp-view';
import { FoveaFocusSettingTab } from './src/settings';
import { FoveaFocusSettings } from './src/types';
import { validateSettings } from './src/services/settings-validator';
import { pdfFilters } from './src/filters';
import { PdfViewIntegration } from './src/pdf-view-integration';
import { locateAnchor, textBetween, withBlock, type DropReason, type PdfNarrative } from './src/pdf';

const DROPPED_AS: Record<DropReason, string> = {
  'header-footer': 'a running header or footer',
  'page-number': 'a page number',
  margin: 'a note in the margin',
  'line-number': 'a line number',
  'front-matter': 'the title-page details',
  footnote: 'a footnote',
  'figure-or-table': 'part of a figure or table',
  equation: 'a displayed equation',
  references: 'the reference list',
  'excluded-section': 'a section on the skip list',
  'after-references': 'text after the reference list',
  caption: 'a caption',
  boilerplate: 'publisher small print',
};

export default class FoveaFocusPlugin extends Plugin {
  private currentModal: FoveaFocusModal | null = null;
  /**
   * Lines of context that the reader's window had room for when it was last laid out, and
   * whether that was on the mobile profile. Null until the reader has been open.
   */
  contextRoom: { lines: number; mobile: boolean } | null = null;
  private settingTab!: FoveaFocusSettingTab;
  private pdf!: PdfViewIntegration;

  settings!: FoveaFocusSettings;
  /** The setup that has been saved as the user's own default, to go back to; null until one is saved */
  /**
   * The default the user has saved: for the settings both devices share, and for those each
   * device keeps for itself once that device has saved them (`savedDefaultOn`).
   */
  savedDefault: FoveaFocusSettings | null = null;
  savedDefaultOn = { computer: false, phone: false };

  async onload() {
    await this.loadSettings();

    this.pdf = new PdfViewIntegration(this.app, this);
    this.pdf.start();

    this.addRibbonIcon('zap', 'Launch speed-reader from cursor', () => {
      void this.launchFromCursor();
    });

    this.addCommand({
      id: 'open',
      name: 'Launch (cursor / selected word)',
      callback: () => void this.launchFromCursor(),
    });

    this.addCommand({
      id: 'read-selection',
      name: 'Read selected text',
      callback: () => void this.readSelection(),
    });

    this.addCommand({
      id: 'read-note',
      name: 'Read entire note (or PDF)',
      callback: () => void this.readWholeFile(),
    });

    // Context menu (Markdown editor only)
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
        const selection = editor.getSelection();
        if (!selection) return;
        menu.addItem((item) => {
          item
            .setTitle('Read with speed reader')
            .setIcon('zap')
            .onClick(() => {
              const modal = this.openModal({ skipInitialAutoLoad: true });
              modal.loadText(selection);
            });
        });
      })
    );

    this.settingTab = new FoveaFocusSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        if (this.currentModal && this.currentModal.isOpen) {
          this.currentModal.updateSettings(this.settings);
        }
      })
    );
  }

  onunload() {
    if (this.currentModal) {
      this.currentModal.close();
      this.currentModal = null;
    }
  }

  async loadSettings() {
    const rawSettings = (await this.loadData()) as
      | (Partial<FoveaFocusSettings> & { savedDefault?: Partial<FoveaFocusSettings> | null; savedDefaultOn?: { computer?: unknown; phone?: unknown } | null })
      | null;
    this.settings = validateSettings(rawSettings);
    this.savedDefault = rawSettings?.savedDefault && typeof rawSettings.savedDefault === 'object' ? validateSettings(rawSettings.savedDefault) : null;
    // A default that was saved before each device had its own was the whole setup: it stands for both
    const on = rawSettings?.savedDefaultOn;
    this.savedDefaultOn = {
      computer: !!this.savedDefault && (on ? on.computer === true : true),
      phone: !!this.savedDefault && (on ? on.phone === true : true),
    };

    // Create data.json immediately on first run so it exists on disk
    if (!rawSettings) {
      await this.saveData(this.settings);
    }
  }

  /** Saves the settings, and with them the setup kept as the user's own default */
  async saveSettings() {
    await this.saveData(this.savedDefault ? { ...this.settings, savedDefault: this.savedDefault, savedDefaultOn: this.savedDefaultOn } : this.settings);
    if (this.currentModal && this.currentModal.isOpen) {
      this.currentModal.updateSettings(this.settings);
    }
  }

  private openModal(options?: { skipInitialAutoLoad?: boolean }): FoveaFocusModal {
    if (this.currentModal && this.currentModal.isOpen) return this.currentModal;
    if (this.currentModal) this.currentModal.close();

    this.currentModal = new FoveaFocusModal(
      this.app,
      this.settings,
      () => {
        this.currentModal = null;
      },
      () => {
        void this.saveSettings();
        this.settingTab.refresh();
      },
      (lines, mobile) => {
        this.contextRoom = { lines, mobile };
      }
    );

    if (options?.skipInitialAutoLoad) {
      this.currentModal.requestSkipInitialAutoLoadOnce();
    }

    this.currentModal.open();
    return this.currentModal;
  }

  /** The PDF the command is about, if the user is in a PDF view. */
  private activePdf(): TFile | null {
    const leaf = this.pdf.activePdfLeaf();
    return leaf ? this.pdf.fileOf(leaf) : null;
  }

  private async narrativeOf(file: TFile): Promise<PdfNarrative | null> {
    try {
      const narrative = await this.pdf.narrativeOf(file, pdfFilters(this.settings));
      if (narrative.units.length) return narrative;
      new Notice('No readable text was found in this PDF');
    } catch (error) {
      console.error('FoveaFocus: could not read the PDF', error);
      new Notice('Could not read this PDF');
    }
    return null;
  }

  private readPdfFrom(file: TFile, narrative: PdfNarrative, token: number): void {
    const modal = this.openModal({ skipInitialAutoLoad: true });
    modal.loadPlainText(narrative.text, { fileName: file.name, cursorPosition: token });
  }

  // ------------------------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------------------------

  private async launchFromCursor(): Promise<void> {
    const pdfFile = this.activePdf();
    if (!pdfFile) {
      if (!this.app.workspace.getActiveFile()) {
        new Notice('No active file found');
        return;
      }
      // A note: the reader loads it from the cursor by itself.
      this.openModal();
      return;
    }

    const selection = this.pdf.selectionIn(pdfFile);
    const narrative = await this.narrativeOf(pdfFile);
    if (!narrative) return;
    if (!selection) {
      new Notice('Reading from the start. To start elsewhere, click or select a word in the PDF first.');
      this.readPdfFrom(pdfFile, narrative, 0);
      return;
    }

    const hit = locateAnchor(narrative, selection.start, selection.text);
    if (hit.ok) {
      this.readPdfFrom(pdfFile, narrative, hit.token);
      return;
    }
    if (hit.reason === 'filtered') {
      // The word was pointed at, so it is read: its block is put back in its place, and
      // reading goes on from it into the text that follows.
      const widened = withBlock(narrative, hit.block);
      const again = locateAnchor(widened, selection.start, selection.text);
      if (again.ok) {
        new Notice(`That word is in ${DROPPED_AS[hit.drop]}, which is normally left out. Reading it from there.`);
        this.readPdfFrom(pdfFile, widened, again.token);
        return;
      }
    }
    new Notice('Could not tell which word that is. Click or select a word in the text.');
  }

  private async readSelection(): Promise<void> {
    const pdfFile = this.activePdf();
    if (!pdfFile) {
      const file = this.app.workspace.getActiveFile();
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const selection = view?.editor.getSelection().trim() || (window.getSelection()?.toString() ?? '').trim();
      if (!file || !selection) {
        new Notice('Select some text first');
        return;
      }
      const modal = this.openModal({ skipInitialAutoLoad: true });
      modal.loadText(selection, { fileName: file.name, lineNumber: view ? view.editor.getCursor('from').line + 1 : undefined });
      return;
    }

    const selection = this.pdf.selectionIn(pdfFile);
    if (!selection?.text) {
      new Notice('Select some text in the PDF first');
      return;
    }
    const narrative = await this.narrativeOf(pdfFile);
    if (!narrative) return;

    // Between two words that are both read, play the cleaned text: columns in order, words
    // rejoined, furniture left out. A selection in text that is not read is played as selected.
    const first = locateAnchor(narrative, selection.start, selection.text);
    const last = locateAnchor(narrative, selection.end);
    const text = first.ok && last.ok ? textBetween(narrative, first.token, last.token) : selection.text;
    const modal = this.openModal({ skipInitialAutoLoad: true });
    modal.loadPlainText(text, { fileName: pdfFile.name });
  }

  private async readWholeFile(): Promise<void> {
    const pdfFile = this.activePdf();
    if (pdfFile) {
      const narrative = await this.narrativeOf(pdfFile);
      if (narrative) this.readPdfFrom(pdfFile, narrative, 0);
      return;
    }

    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('No active file found');
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const content = view?.editor.getValue() ?? (await this.app.vault.read(file));
    const modal = this.openModal({ skipInitialAutoLoad: true });
    modal.loadText(content, { fileName: file.name, lineNumber: 1 });
  }
}
