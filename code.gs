function myFunction() {
  // Notes the message must not have reply -> solved
  // select current date or in future to prevent any mistake when sending -> solve by filter [ unread , from , cc]
  // Manage script configuration here
  const config = {
    labelName: 'Auto-replied',
    htmlBody: `<div style='text-align: right'>
              <p>وعليكم السلام ورحمة الله</p>
              <p>تم اخذ العلم ولا مانع</p>
          </div>`
  };
  // get all message in script ends with custom domain
  // add cc:test@companyname.com
  var threads = GmailApp.search('in:inbox to:team-leader@companyname.com is:unread from:companyname.com');
  threads.forEach(function (thread) {
    var messages = thread.getMessages();
    // check if there is reply in current thread ( message ).
    if (thread.getMessageCount() <= 1) {
      // add label to messages
      messages.forEach(function (message) {
        var body = message.getPlainBody();
        var subject = message.getSubject();
        if (body.indexOf('جازة') > -1 || body.indexOf('مغادرة') > -1 || body.indexOf('خروج') > -1 ||
        subject.indexOf('جاز') > -1 || subject.indexOf('مغادرة') > -1 || subject.indexOf('خروج') > -1) {
          thread.replyAll(" ", {
            htmlBody: config.htmlBody,
          });
          thread.addLabel(GmailApp.getUserLabelByName(config.labelName));
        }
      });
    }
  });
}