// Gmail Acknowledgement Reply Bot (Apps Script)
const ACK_BOT_CONFIG = {
  targetToEmail: 'team-leader@companyname.com',
  fromDomainQuery: 'from:companyname.com',
  labelName: 'Auto-replied',
  keywords: ['جازة', 'مغادرة', 'خروج', 'جاز'],
  htmlBody: `<div style='text-align: right'>
              <p>وعليكم السلام ورحمة الله</p>
              <p>تم اخذ العلم ولا مانع</p>
          </div>`,
};

function autoAcknowledgeTeamLeaderInbox() {
  const config = ACK_BOT_CONFIG;
  const label = getOrCreateLabel_(config.labelName);
  const query = buildSearchQuery_(config);

  const threads = GmailApp.search(query);
  threads.forEach((thread) => {
    try {
      if (thread.getMessageCount() !== 1) return;

      const message = thread.getMessages()[0];
      if (!isDirectlyAddressedTo_(message, config.targetToEmail)) return;

      const subject = message.getSubject() || '';
      const body = message.getPlainBody() || '';
      if (!matchesKeywords_(subject, body, config.keywords)) return;

      thread.replyAll(' ', { htmlBody: config.htmlBody });
      thread.addLabel(label);
      thread.markRead();
    } catch (error) {
      console.error('Ack bot failed for thread', thread.getId(), error);
    }
  });
}

function buildSearchQuery_(config) {
  const target = config.targetToEmail;
  const label = config.labelName;

  return [
    'in:inbox',
    'is:unread',
    config.fromDomainQuery,
    `to:${target}`,
    `-cc:${target}`,
    `-bcc:${target}`,
    `-label:${label}`,
  ].join(' ');
}

function getOrCreateLabel_(labelName) {
  return GmailApp.getUserLabelByName(labelName) || GmailApp.createLabel(labelName);
}

function isDirectlyAddressedTo_(message, targetEmail) {
  const toEmails = extractEmails_(message.getTo()).map((email) => email.toLowerCase());
  return toEmails.includes(String(targetEmail).toLowerCase());
}

function matchesKeywords_(subject, body, keywords) {
  const haystack = `${subject}\n${body}`;
  return keywords.some((keyword) => haystack.indexOf(keyword) !== -1);
}

function extractEmails_(headerValue) {
  if (!headerValue) return [];
  return headerValue.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
}

// Backward compatibility for existing triggers.
function myFunction() {
  autoAcknowledgeTeamLeaderInbox();
}
