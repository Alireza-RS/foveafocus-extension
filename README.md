# FoveaFocus for the browser

FoveaFocus reads web pages and PDF articles one word at a time, each word on a fixed mark (RSVP: Rapid Serial Visual Presentation). This is the reader of the FoveaFocus plugin for Obsidian as an extension for Chrome and Vivaldi: the same reader, with the same settings, over the page that is being read. It runs on a computer, and on a phone or a tablet in a browser that takes extensions there.

## What it does

- Reads the article of a web page and leaves out what is not the article: menus, sidebars, footers, lines of links, code, tables and the reference list. A page that is no article is read as it stands.
- Shows a PDF that is open in the browser, from the web or from the disk, in a viewer of its own, and reads it from any word in it: columns in reading order, words that were split over two lines joined again, page furniture left out.
- Reads text files and Markdown files that are open in the browser: a Markdown file as the note it is, any other text with its signs as they stand.
- Follows the links of a PDF: to a web page, to an app such as Obsidian, and to a file on the computer.
- Shows the reader over the page, on a dark ground that covers the page until the reader is closed.
- Keeps the structure of the text: headings are shown as headings, and the outline at the top of the reader jumps between them.

## Starting a reading

| By | What is read |
| --- | --- |
| The bar at the side of a page, first button | A web page: a long selection alone; otherwise the page, from a short selection where there is one. A PDF: from the first selected word, or from its start |
| The bar, second button | A web page from a place that is then clicked in it; a PDF from a word that is then clicked in it |
| `Alt+Shift+F` | The same as the first button of the bar |
| `Alt+Shift+G` | The same as the second button of the bar |
| The bar, third button | What is selected, and no more |
| The menu of the page (right click) with text selected: Read from the selection | The page or the PDF from the first selected word on |
| The menu of the page with text selected: Read only the selection | The selection, and no more |
| The menu of the page with nothing selected: Read from here | The page or the PDF from where the menu was opened |
| The menu of the page: Read from the start | The page or the PDF from its start, whatever is selected |

On a web page a selection counts as short up to 30 characters; the settings change that. In a text file, a place that is clicked or that the menu was opened on starts the reading at its line. Pressed again while the reader is open, `Alt+Shift+F` closes the reader. The two shortcuts can be changed on the browser's page of extension shortcuts, which the settings of the extension open.

## PDFs

The browser's own viewer of a PDF tells an extension which words are selected and nothing of where on the page they lie, and of a click it tells nothing at all. So FoveaFocus lays a viewer of its own over it, in the same tab and at the same address, and shows the PDF there. In that viewer a reading starts at the very word that is selected or clicked, however often that word stands in the document: the word is found by its place on the page, never by what it says.

- A selection, of one word or of many, is where the reading starts: by the first button of the bar, by `Alt+Shift+F` and by "Read from the selection". The third button of the bar and "Read only the selection" read the selection and no more. With nothing selected, the PDF is read from its start.
- The second button of the bar, or `Alt+Shift+G`, frames the word under the pointer, and a click starts the reading at that word. Esc leaves it.
- "Read from here" starts at the word the menu was opened on.
- A start in a part that is normally left out, such as a footnote, a caption or the reference list, is read from there all the same, and the page says so.
- A word under a link, or under a stamp that is printed across the page, is found all the same.

A PDF is read up to its first 400 pages. Three things are not read: a PDF that asks for a password, which the browser's viewer shows; a PDF with no text in it, such as a scan; and words that a page shows on their side.

The strip over the pages has the number of the page, the size of the pages and a search (`Ctrl+F`). With the Control key held, the wheel and the keys `+`, `-` and `0` change the size; so do two fingers on a touchpad or a touch screen. In a narrow window the strip keeps the page and the two buttons for the size, and a button shows the search in a row of its own.

"Browser's viewer", at the end of the strip, shows the PDF in the browser's own viewer again, which is also where it is printed and saved. Over the browser's viewer the first button of the bar lays the viewer of FoveaFocus over the PDF again. A reading asked for there, by `Alt+Shift+F`, `Alt+Shift+G` or the menu of the page, does the same and then goes on in the viewer of FoveaFocus; only words selected in the browser's viewer are read as they are, alone, since where they lie is not known. A switch in the settings of the extension leaves every PDF to the browser's viewer until that button is pressed. A PDF that FoveaFocus cannot show, such as one that asks for a password, stays in the browser's viewer.

### Links

A link in a PDF is followed by a click. What the click does goes by the kind of the link, and each kind has a setting:

| Link | A click | Setting |
| --- | --- | --- |
| To a web page | Opens it in a new tab | A new tab, the same tab, or not followed |
| To an app, such as `obsidian://...` or an email address | Hands it to the browser, in the same tab. The browser asks before it opens the app, unless it was told to open such links always | On or off |
| To a file on the computer | Opens it in the same tab, and only from a PDF that is itself on the computer | On or off |
| To a place in the PDF itself | Goes there | |

A link that would run a script is never followed. While a word to read from is being picked, a click follows no link.

## The bar

The bar is small, and faint until it is pointed at; beside the pages of a PDF in the viewer of FoveaFocus it is in plain sight. The first time it is shown, it says beside each button what the button does. The button of the extension in the toolbar of the browser shows or hides it in the tab it is pressed in, for as long as that tab is open, whatever the settings say; a key can be given to it on the browser's page of shortcuts, where it is listed as "Activate the extension". The last button of the bar hides it on the site it is on, or on every site, and opens the settings, which bring it back.

Two switches in the settings change how the bar rests. Folded, it is one round button, which shows the others when it is pressed; a press beside the bar folds it again. Moved, it can be dragged to another place at either side of the window, and rests there. On a phone or a tablet both are switched on to begin with.

"How it works", in the menu of the bar and in the settings, opens a page with a few steps and a text to try them on.

## On a phone or a tablet

The extension runs in a browser for Android that takes extensions, such as Vivaldi. The bar rests there as one round button, faint until it is touched: a tap shows the other buttons, a touch on the page tucks them away again, and the button moves when it is held and dragged. The place to read from is picked by a tap, and the reader has its controls and its settings for a touch screen.

Such a browser shows no PDF as a page, so there is no viewer of its own to lay another over. A tab that is on its way to a PDF on the web is sent to a page of the extension instead, which shows the PDF in the viewer of FoveaFocus, with the bar and the reader. "Download", at the end of the strip, has the browser keep the file, which is what it does with a PDF otherwise. A PDF that is on the device is chosen from its files: "Open a PDF from this device", in the menu of the bar. A file that its site offers as a download is left to the browser, and the switch in the settings leaves every PDF to it.

The bar offers no hiding there, since the button of the browser that brings a hidden bar back is out of the way; the settings switch the bar off. The lines in the menu of a page are left out as well: a long press, which would bring that menu up, is what selects a word, and the bar does what the lines do.

The reader, the settings, the viewer of PDFs and the bar come in three colours of the extension's own, whether the browser is set to light or to dark: a dark ground, a light text and the colour of the marked letter. The settings change the three for the reader.

## The reader

| Key | Does |
| --- | --- |
| Space | Play or pause |
| Left, Right | Back or forward 10 seconds |
| Up, Down | Previous or next heading |
| Ctrl + Left, Ctrl + Right | Jump to the start or the end |
| Shift + Up, Shift + Down | Faster or slower |
| S | The settings of the reader |
| Esc | Close the reader |

A click in the word area plays and pauses as well. While paused, the wheel steps through the text word by word, and a click on the progress bar jumps to that place.

## Settings

The settings are those of the plugin: speed, text size, pauses, colours, the lines of text round the word, what is left out of a page and of a PDF, and how a reading starts. Under them stand the settings of the extension itself: the bar, the viewer of PDFs and the links of a PDF. They are opened from the bar, or from the browser's list of extensions. What is set in the reader itself is kept as well.

The settings are kept in the browser, on the device they were made on.

## Files from the disk

A PDF, a page or a text file that was opened from the disk can be read once the browser lets the extension at such files: on the browser's page of the extension, the switch "Allow access to file URLs". When the extension is called on in a tab with such a file while the switch is off, by its button, the menu or a shortcut, it opens a page that says so.

## Installing from this folder

The extension runs in Chrome 136 or later, and in the browsers built on it, such as Vivaldi. Vivaldi for Android loads the folder in the same way, from its page of extensions.

1. Build the extension (see below), or use a `dist` folder that is already built.
2. Open the browser's page of extensions: `chrome://extensions` in Chrome, `vivaldi://extensions` in Vivaldi.
3. Switch on "Developer mode".
4. Choose "Load unpacked" and pick the `dist` folder.

After a new build, the extension is loaded again with the reload button on that page, or removed there and loaded once more. A browser that is only closed and started again goes on running the background part of the old build. A page that was open before keeps the bar of the old build, which says that the extension was updated when it is used, and a PDF keeps the viewer of the old build; loading the page again, or pressing the button in the toolbar, puts a working bar and viewer in their place.

## Building

```bash
npm install
npm run build     # type-checks, then builds dist/
npm run dev       # builds again whenever a source file changes
```

## Privacy

Everything happens in the browser, and nothing is sent anywhere. `PRIVACY.md` says what the extension handles and what it keeps.

## History and credit

The reader in `core/` is the source of the FoveaFocus plugin for Obsidian, copied unchanged. That plugin began as a fork of [DashReader](https://github.com/inattendu/dashreader) by inattendu, taken at its version 1.4.2; the copyright notice of the original is kept in `LICENSE`.

The extension builds on three libraries: [PDF.js](https://mozilla.github.io/pdf.js/) shows PDFs and reads the text out of them, [Readability](https://github.com/mozilla/readability) finds the article of a web page, and the icons are from [Lucide](https://lucide.dev). Their licences go into `dist/licenses/` with every build; the fonts, character maps and decoders that PDF.js brings have theirs beside them in `dist/pdfjs/`.

## Licence

MIT. See `LICENSE`.
