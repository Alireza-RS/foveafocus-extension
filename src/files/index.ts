/**
 * The page that says how the browser is told to let the extension read files on the disk.
 * It is shown when the extension is called on in a tab with such a file while that is not allowed.
 */

const said = document.getElementById('status') as HTMLElement;

document.getElementById('open')?.addEventListener('click', () => {
  void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

async function tell(): Promise<void> {
  const allowed = await chrome.extension.isAllowedFileSchemeAccess();
  said.textContent = allowed ? 'It is switched on now. Load the tab with the file again, and read.' : 'It is not switched on yet.';
}

void tell();
window.setInterval(() => void tell(), 1500);
