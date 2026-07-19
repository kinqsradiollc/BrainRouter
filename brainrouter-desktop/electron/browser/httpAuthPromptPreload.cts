export {};

const { ipcRenderer: authIpcRenderer } = require('electron') as typeof import('electron');

const CHANNEL_ARGUMENT = '--brainrouter-http-auth-channel=';
const TOKEN_ARGUMENT = '--brainrouter-http-auth-token=';
const channel = process.argv.find((argument) => argument.startsWith(CHANNEL_ARGUMENT))?.slice(CHANNEL_ARGUMENT.length) ?? '';
const token = process.argv.find((argument) => argument.startsWith(TOKEN_ARGUMENT))?.slice(TOKEN_ARGUMENT.length) ?? '';
const validChannel = /^brainrouter:http-auth:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(channel);
const validToken = /^[0-9a-f]{64}$/i.test(token);

if (validChannel && validToken) {
  window.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('auth-form');
    const username = document.getElementById('username');
    const password = document.getElementById('password');
    const cancel = document.getElementById('cancel');
    if (!(form instanceof HTMLFormElement)
      || !(username instanceof HTMLInputElement)
      || !(password instanceof HTMLInputElement)
      || !(cancel instanceof HTMLButtonElement)) return;

    let sent = false;
    const disableAndClear = (): void => {
      username.disabled = true;
      password.value = '';
      password.disabled = true;
      for (const button of form.querySelectorAll('button')) button.disabled = true;
    };
    const submit = (): void => {
      if (sent) return;
      sent = true;
      authIpcRenderer.send(channel, {
        token,
        action: 'submit',
        username: username.value,
        password: password.value,
      });
      disableAndClear();
    };
    const cancelPrompt = (): void => {
      if (sent) return;
      sent = true;
      authIpcRenderer.send(channel, { token, action: 'cancel' });
      disableAndClear();
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submit();
    });
    cancel.addEventListener('click', cancelPrompt);
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancelPrompt();
    });
  }, { once: true });
}
