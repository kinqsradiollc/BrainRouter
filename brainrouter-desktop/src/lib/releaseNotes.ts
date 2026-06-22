/** "What's new" — asks the host for the release recap (rendered into the chat). */
export function sendReleaseNotes(): void {
  window.brainrouter.send({ kind: 'query', id: 'q-recap', name: 'recap' });
}
