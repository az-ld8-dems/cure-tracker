// "Send feedback": one box. The Worker emails the message to whoever runs the site, with the sender's name and the page they came from.
import { $, api, banner, boot, clear, failureText, field, h, toast } from './common.ts';

const me = await boot();
const app = $('#app');

// The page that linked here, as a path (nothing after it), so the message says what they were looking at.
function cameFrom(): string {
  try {
    const url = new URL(document.referrer);
    return url.origin === location.origin && url.pathname !== location.pathname ? url.pathname : '';
  } catch {
    return '';
  }
}

if (me) {
  const page = cameFrom();
  const message = h('textarea', { class: 'fl-textarea', id: 'message', rows: '8', maxlength: 4000, required: true });
  const send = h('button', { class: 'btn', type: 'submit' }, 'Send feedback');
  const form = h(
    'form',
    {
      class: 'fl-card fl-stack fl-stack--3',
      onsubmit: async (event: Event) => {
        event.preventDefault();
        send.disabled = true;
        try {
          await api('POST', '/api/feedback', { message: message.value, page });
          clear(app, banner('info', h('p', {}, 'Thank you. Your message was sent.')));
        } catch (e) {
          toast(failureText(e), 'error');
          send.disabled = false;
        }
      },
    },
    field('message', 'What would you like to tell us?', message),
    h(
      'p',
      { class: 'fl-help' },
      'Please do not put voters’ names, phone numbers or addresses in your message. Describe what you were doing instead, for example “the Claim button did nothing on the Map page”.',
    ),
    send,
  );
  clear(app, form);
}
