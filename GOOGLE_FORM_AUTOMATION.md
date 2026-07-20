# Google Form → ReelVotes Automation

This flow lets a theater submit one Google Form and automatically:
1. create/update an event in Firestore,
2. populate its movie list,
3. queue an email blast to everyone in `email_signups`.

## 1) Deploy the new function

Function name:
- `ingestTheaterFormSubmission`

Endpoint format:
- `https://us-central1-reelconvo.cloudfunctions.net/ingestTheaterFormSubmission`

## 2) Configure automation token (required)

Set environment variable for Functions:
- `GOOGLE_FORM_AUTOMATION_TOKEN=<long-random-secret>`

Use a long random value and keep it private.

## 3) Google Form fields

Recommended fields:
- `Admin Email` (must be in admin allowlist)
- `Theater Name`
- `Screening Date Time` (format: `YYYY-MM-DDTHH:mm`, example `2026-08-11T18:30`)
- `Vote Status` (`not-started`, `live`, or `ended`)
- `Require Email` (`true/false`)
- `Movie Titles` (newline/comma/semicolon separated)
- `Send Announcement` (`true/false`)
- `Email Subject` (optional)
- `Email Intro` (optional)

## 4) Attach Apps Script to the Form

Create Apps Script for the linked Sheet and set an `On form submit` trigger:

```javascript
function onFormSubmit(e) {
  const values = e.namedValues || {};

  const payload = {
    token: PropertiesService.getScriptProperties().getProperty('REELVOTES_AUTOMATION_TOKEN'),
    adminEmail: (values['Admin Email'] || [''])[0],
    theaterName: (values['Theater Name'] || [''])[0],
    screeningDateTime: (values['Screening Date Time'] || [''])[0],
    voteStatus: (values['Vote Status'] || ['not-started'])[0],
    requireEmail: (values['Require Email'] || ['true'])[0],
    movieTitles: (values['Movie Titles'] || [''])[0],
    sendAnnouncement: (values['Send Announcement'] || ['true'])[0],
    emailSubject: (values['Email Subject'] || [''])[0],
    emailIntro: (values['Email Intro'] || [''])[0],
    replaceMovieList: true,
  };

  const url = 'https://us-central1-reelconvo.cloudfunctions.net/ingestTheaterFormSubmission';

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    headers: {
      'X-ReelVotes-Automation-Token': payload.token,
    },
  });

  Logger.log(res.getResponseCode());
  Logger.log(res.getContentText());
}
```

Then set script property:
- key: `REELVOTES_AUTOMATION_TOKEN`
- value: same token as `GOOGLE_FORM_AUTOMATION_TOKEN`

## 5) Behavior notes

- Event ID is auto-derived from `screeningDateTime` as `np-YYYY-MM-DD-HHmm`.
- If event exists, it is updated (`replaceMovieList` defaults to true).
- Announcement emails are queued in Firestore `mail` collection (for the installed mail extension/service).
- To re-send an announcement for an already-announced event, pass `forceResendAnnouncement: true`.

## 6) Your current Google Form mapping (Cornell form)

For form:
- https://docs.google.com/forms/d/14KjwcZz1aS9keqQkdDddJEeagq-ipTcBGL8mbXe3UxE/edit

Use these exact question titles from the form:
- `Name of Theater`
- `Address of Theater`
- `Ticketing Email (in case there are problems or questions)`
- `Date of Screening`
- `Time of Screening`
- `List of Ten Possible Movie Options for Vote`
- `Target Number of Ticket Buyers to Make Screening Successful`
- `Minimum Number of People Voting for the Leading Movie for the Vote to be Successful`
- `Minimum Number of Tickets Sold During Test Period for the Screening to Occur`

Suggested Apps Script (Sheet-bound `onFormSubmit` trigger):

```javascript
function toIsoDateTime(dateValue, timeValue) {
  const tz = Session.getScriptTimeZone() || 'America/Los_Angeles';
  const d = new Date(dateValue);
  const t = new Date(timeValue);

  const yyyy = Utilities.formatDate(d, tz, 'yyyy');
  const mm = Utilities.formatDate(d, tz, 'MM');
  const dd = Utilities.formatDate(d, tz, 'dd');
  const hh = Utilities.formatDate(t, tz, 'HH');
  const min = Utilities.formatDate(t, tz, 'mm');

  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function onFormSubmit(e) {
  const values = e.namedValues || {};

  const theaterName = (values['Name of Theater'] || [''])[0].trim();
  const theaterAddress = (values['Address of Theater'] || [''])[0].trim();
  const ticketingEmail = (values['Ticketing Email (in case there are problems or questions)'] || [''])[0].trim();
  const screeningDate = (values['Date of Screening'] || [''])[0];
  const screeningTime = (values['Time of Screening'] || [''])[0];
  const screeningDateTime = toIsoDateTime(screeningDate, screeningTime);
  const targetTicketBuyers = (values['Target Number of Ticket Buyers to Make Screening Successful'] || [''])[0].trim();
  const minimumLeadingVotes = (values['Minimum Number of People Voting for the Leading Movie for the Vote to be Successful'] || [''])[0].trim();
  const minimumTicketsTestPeriod = (values['Minimum Number of Tickets Sold During Test Period for the Screening to Occur'] || [''])[0].trim();

  const movieTitles = (values['List of Ten Possible Movie Options for Vote'] || [''])[0]
    .split(/\r?\n|,|;/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n');

  const payload = {
    token: PropertiesService.getScriptProperties().getProperty('REELVOTES_AUTOMATION_TOKEN'),
    adminEmail: 'rt332@cornell.edu',
    theaterName,
    theaterAddress,
    ticketingEmail,
    screeningDateTime,
    voteStatus: 'not-started',
    requireEmail: true,
    movieTitles,
    targetTicketBuyers,
    minimumLeadingVotes,
    minimumTicketsTestPeriod,
    sendAnnouncement: true,
    replaceMovieList: true,
    emailSubject: `New ReelVotes screening at ${theaterName}`,
    emailIntro: 'A new screening vote is open. Vote now for the movie you want to see most.',
  };

  const url = 'https://us-central1-reelconvo.cloudfunctions.net/ingestTheaterFormSubmission';

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    headers: {
      'X-ReelVotes-Automation-Token': payload.token,
    },
  });

  Logger.log(res.getResponseCode());
  Logger.log(res.getContentText());
}
```
