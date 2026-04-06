function sendActivity() {
  const url = window.location.href;
  if (!/^https?:\/\//i.test(url)) return;
  chrome.runtime.sendMessage({
    type: 'site-activity',
    url,
    ts: Date.now(),
  });
}

let lastSentAt = 0;
function onUserActivity() {
  const now = Date.now();
  if (now - lastSentAt < 5000) return;
  lastSentAt = now;
  sendActivity();
}

window.addEventListener('mousemove', onUserActivity, { passive: true });
window.addEventListener('keydown', onUserActivity, { passive: true });
window.addEventListener('click', onUserActivity, { passive: true });
sendActivity();

function isVkHost() {
  return /(^|\.)vk\.com$/i.test(window.location.hostname);
}

function injectVkButtons() {
  if (!isVkHost()) return;
  const selector = 'a[href$=".doc"], a[href$=".docx"], a[href*=".doc?"], a[href*=".docx?"]';
  const links = document.querySelectorAll(selector);

  links.forEach((link) => {
    if (link.dataset.lab6Handled === '1') return;
    link.dataset.lab6Handled = '1';

    const button = document.createElement('button');
    button.textContent = 'проверить';
    button.type = 'button';
    button.style.marginLeft = '8px';
    button.style.padding = '2px 8px';
    button.style.cursor = 'pointer';
    button.style.border = '1px solid #4f46e5';
    button.style.borderRadius = '6px';
    button.style.background = '#eef2ff';
    button.style.color = '#312e81';
    button.style.fontSize = '12px';

    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({
        type: 'open-check-panel',
        url: link.href,
      });
    });

    link.insertAdjacentElement('afterend', button);
  });
}

injectVkButtons();
const observer = new MutationObserver(() => injectVkButtons());
observer.observe(document.documentElement, { childList: true, subtree: true });
