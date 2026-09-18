/**
 * Raw MIME messages, as Email Routing would hand them over.
 *
 * Written out rather than generated because the point of these is the shapes real mail clients
 * produce — a multipart alternative, an HTML-only message, a Gmail-style quoted reply — and a
 * generator would produce whatever we already believed.
 */

const plainText = [
  'From: Someone <someone@example.test>',
  'To: soporte@franciscosolis.cl',
  'Subject: The sign-in link never arrives',
  'Message-ID: <plain-1@example.test>',
  'Date: Tue, 3 Jan 2026 14:02:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'I have asked for a sign-in link four times and none of them arrive.',
  '',
].join('\r\n')

const htmlOnly = [
  'From: Someone <someone@example.test>',
  'To: soporte@franciscosolis.cl',
  'Subject: Billing question',
  'Message-ID: <html-1@example.test>',
  'Date: Tue, 3 Jan 2026 14:05:00 +0000',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><p>My invoice says <b>two</b> seats but we only have one.</p>',
  '<script>alert("nope")</script></body></html>',
  '',
].join('\r\n')

const quotedReply = (subject: string, messageId: string, to = 'soporte@franciscosolis.cl') =>
  [
    'From: Someone <someone@example.test>',
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${messageId}@example.test>`,
    'Date: Tue, 3 Jan 2026 15:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'That did not help, it still fails.',
    '',
    'On Tue, 3 Jan 2026 at 14:30, Support <soporte@franciscosolis.cl> wrote:',
    '> Could you try a different browser?',
    '',
  ].join('\r\n')

/** No `Message-ID` at all, which is commoner than it should be. */
const withoutMessageId = [
  'From: Someone <someone@example.test>',
  'To: soporte@franciscosolis.cl',
  'Subject: No identifier on this one',
  'Date: Tue, 3 Jan 2026 16:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'My account will not let me change my password.',
  '',
].join('\r\n')

const withAttachment = [
  'From: Someone <someone@example.test>',
  'To: soporte@franciscosolis.cl',
  'Subject: Screenshot of the error',
  'Message-ID: <attach-1@example.test>',
  'Date: Tue, 3 Jan 2026 17:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="sep"',
  '',
  '--sep',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Here is what I see.',
  '',
  '--sep',
  'Content-Type: image/png; name="screenshot.png"',
  'Content-Disposition: attachment; filename="screenshot.png"',
  'Content-Transfer-Encoding: base64',
  '',
  'iVBORw0KGgoAAAANSUhEUg==',
  '',
  '--sep--',
  '',
].join('\r\n')

export { htmlOnly, plainText, quotedReply, withAttachment, withoutMessageId }
