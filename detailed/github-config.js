/* ============================================================
   SURVIVING ADAMSVILLE — Report sending configuration
   FILE: github-config.js
   ------------------------------------------------------------
   WHAT THIS FILE DOES:
   Tells the game WHERE to send diagnostic reports (inspector
   findings, stuck vehicles, errors, performance warnings).
   The game never talks to GitHub itself and holds no key.

   HOW IT WORKS NOW — THE GOOGLE FORM (Joshua's ruling,
   2026-10-25, replacing the relay plan of 2026-10-24):
   * Players must NEVER need a GitHub key. Other people will
     play this game, and a key inside a public game file can
     be read by anyone who downloads the game.
   * So the game POSTs each report straight into a Google
     Form that Joshua owns ("Surviving Adamsville — Player
     Reports"), with NO key and NO sign-in: the form accepts
     anonymous submissions, exactly like a public survey.
     Reports land in the form's responses, which Mollie reads
     through the Forms API. Nothing and nobody needs a GitHub
     key anywhere in this design.
   * The settings that matter are REPORT_FORM_URL and
     REPORT_FORM_ENTRIES below: the form's submission address
     and the field codes for its six questions. Both are
     PUBLIC form addresses, not secrets — anyone may read
     them; the worst that allows is posting a junk response
     into the form.
   * EVERYTHING THE GAME CAN KNOW IS FILLED IN BY THE CODE
     (Joshua's wiring principle, 2026-10-25): device, where
     in the game, game version and report type are filled
     automatically. The player is only ever left with the one
     part that needs a human — the feedback message itself.
     Crash and other automatic reports need no player input
     at all.
   * The old Apps Script RELAY plan (REPORT_RELAY_URL) is
     RETIRED — the relay was never deployed. The setting is
     kept only as an unused fallback: the sender prefers the
     form whenever REPORT_FORM_URL is set, and would use the
     relay only if the form address were emptied AND a relay
     address filled in. Leave it "".
   * If NO destination is configured, sending is OFF: reports
     stay queued on the device and the manual/export behaviour
     is the fallback. No report is lost just because an
     address is empty — the queue simply waits.

   There is deliberately NO token setting in this file any
   more. The old direct-to-GitHub upload (token pasted here,
   or stored per-device with GitHubReports.setToken) was
   removed on 2026-10-24 because its token died and because
   shipping any working key in a public game is not safe.
   Do not paste a token here — nothing reads one any more.
   (Two older helpers, crashlog.js and worldfix_sync.js, still
   look for a token in this config / browser storage. With no
   token anywhere they simply stay off, exactly as they have
   since the old token died. Wiring them through the relay is
   a separate job, not part of this file.)
   ------------------------------------------------------------
   Documentation comments are required on all game code —
   Joshua's standing rule. This file follows it.
   ============================================================ */

window.GITHUB_CONFIG = {
  /* The Google Form submission address (Joshua's ruling,
     2026-10-25). This is the formResponse endpoint of
     "Surviving Adamsville — Player Reports", the Google Form
     Joshua owns. It is a PUBLIC address, not a secret: the
     form accepts anonymous submissions, and the game holds
     NO key. Each report is POSTed here as one form response
     (see REPORT_FORM_ENTRIES for the field codes). If this
     were emptied, the sender would fall back to the relay
     below if one were set, else reports queue on-device. */
  REPORT_FORM_URL: "https://docs.google.com/forms/d/e/1FAIpQLSeLwZKjsqKoCRVIuedhSD5NXJFO_WkwJtG7ExjXjCV6seakMg/formResponse",

  /* The form's field codes: which POST parameter answers
     which question. Extracted from the form's public page
     when the form was built (2026-10-25); the full record,
     including the Forms API question IDs, lives in
     game-map/report-relay/GOOGLE-FORM.md. If the form is
     ever rebuilt, these codes change and must be re-read
     from the new form — the questions' wording would stay
     the same but the codes would not. */
  REPORT_FORM_ENTRIES: {
    type:    "entry.245308779",   // "Report type" (Bug/Crash/Feedback/Other)
    message: "entry.722588258",   // "What happened?" (player words first)
    version: "entry.1808724204",  // "Game version" (auto-filled)
    where:   "entry.613460102",   // "Where in the game" (auto-filled)
    device:  "entry.1017388942",  // "Device" (auto-filled)
    name:    "entry.1227514984"   // "Player name (optional)" (usually blank)
  },

  /* The RETIRED relay's web address (Apps Script plan,
     replaced by the Google Form above on 2026-10-25; the
     relay was never deployed). Kept only as an unused
     fallback: the sender uses it ONLY if REPORT_FORM_URL is
     empty AND this is filled in. Leave it "" (empty). */
  REPORT_RELAY_URL: "",

  /* Client tag. This is NOT a password and NOT a credential.
     The retired relay used it to ignore random junk posts;
     the Google Form path does not send it (a form response
     has no use for it). Kept so the fallback relay bundle
     format is unchanged and older helpers keep working. */
  REPORT_CLIENT_TAG: "surviving-adamsville-game",

  /* Which repo the reports were ORIGINALLY headed for (the
     retired relay would have written report files there).
     Kept so report payloads can still name their origin and
     older helpers can still find it. The Google Form path
     does not write to the repo at all — reports live in the
     form's responses, in Joshua's Google account. */
  repo: "kingmarkarnold-code/adamsville-play",

  /* Folder inside the repo where the retired relay would
     have written report files. Unused by the form path. */
  reportsDir: "reports",

  /* Master switch. Reports only send when this is true AND
     a destination is set (REPORT_FORM_URL, or the retired
     REPORT_RELAY_URL as fallback). */
  enabled: true,

  /* How often (milliseconds) queued reports are sent in one
     batch. 5 minutes = 300000. */
  flushIntervalMs: 5 * 60 * 1000,

  /* Maximum reports kept in the queue. Oldest are dropped first
     so a long session can never grow memory without bound. */
  maxQueue: 200
};
