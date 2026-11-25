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

const items = document.getElementById('items');
for (let index = 1; index <= 40; index += 1) {
  const item = document.createElement('li');
  item.textContent = `Item ${index}`;
  items.append(item);
}
