// The sign-in window's script: it talks to the main process through the
// preload bridge only.
const form = document.getElementById('sign-in');
const status = document.querySelector('[data-testid="status"]');
const count = document.querySelector('[data-testid="count"]');

void window.testbed.greeting().then((text) => {
  document.getElementById('greeting').textContent = text;
});

// A remembered user survives a relaunch: it lives in the app's data, which `app.clearState()` empties.
const remembered = localStorage.getItem('remembered-user');
if (remembered !== null) {
  form.elements.namedItem('username').value = remembered;
  status.textContent = `Welcome back, ${remembered}`;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const result = await window.testbed.signIn({
    username: String(data.get('username')),
    password: String(data.get('password')),
    plan: String(data.get('plan')),
    remember: data.get('remember') === 'on',
  });
  status.textContent = result.message;
  if (result.ok && data.get('remember') === 'on') localStorage.setItem('remembered-user', String(data.get('username')));
});

document.getElementById('increment').addEventListener('click', () => {
  count.textContent = String(Number(count.textContent) + 1);
});

document.getElementById('open-settings').addEventListener('click', () => {
  void window.testbed.openSettings();
});

// A web component's content sits in an open shadow root, where a CSS locator still reaches it.
document.getElementById('badge-host').attachShadow({ mode: 'open' }).innerHTML = '<span class="badge">Beta</span>';

// A field that hands focus on to the username field as soon as it gets it, as a focus trap can.
document.querySelector('[data-testid="handoff"]').addEventListener('focus', () => {
  document.querySelector('[data-testid="username"]').focus();
});

// A field that swallows every key press, as a masked input that handles keys itself does.
document.querySelector('[data-testid="invite"]').addEventListener('keydown', (event) => event.preventDefault());

const items = document.getElementById('items');
for (let index = 1; index <= 40; index += 1) {
  const item = document.createElement('li');
  item.textContent = `Item ${index}`;
  items.append(item);
}
