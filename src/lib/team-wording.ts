/** Words for the team view, handover, brief, suggestions and reports. Listed in the PR body under "Wording for Daniel". */
export const TEAM_WORDS = {
  people: "On the care team",
  openItems: "Open items",
  overdue: "Follow-ups overdue",
  dueThisWeek: "Due this week",
  journeySteps: "Journey steps coming",
  lastContact: "Last contact logged",
  none: "None yet",
  restrictedLine: "May hold restricted items not shown.",
  needsSomeone: "Needs someone",
  needsIntro: "Work that nobody is holding, or that has waited. Each row opens the thing itself.",
  noOwner: "Care items held by someone who has left",
  unassigned: "Follow-ups nobody is holding",
  inbox: "Waiting in the Inbox for more than 2 days",
  volunteers: "Volunteer tasks with no one yet, in the next 3 days",
  meals: "Meal pages with open nights in the next 3 days",
  nothing: "Nothing here.",
  giveTo: "Give to",
} as const;

export const HANDOVER_WORDS = {
  button: "Hand over their work",
  title: "Hand over their work",
  explain: "Give what they hold to someone else before they go. You can give it all to one person, or choose for each one.",
  items: "Care items",
  followUps: "Follow-ups",
  leadSteps: "Mitzvah Corps steps",
  giveAllTo: "Give all to",
  ownersOption: "Whoever holds each care item",
  restrictedNote: "Restricted items, if there are any, are handed over from the list below once they are deactivated.",
  confirm: "Hand over and deactivate",
  none: "They hold no open work.",
} as const;

export const BRIEF_WORDS = {
  button: "Brief me",
  title: "Brief",
  open: "What is open",
  contacts: "Last contacts",
  next: "Coming up",
  household: "Household",
  address: "Address",
  openInMaps: "Open in Google Maps",
  dates: "Dates coming",
  meals: "Mitzvah Meals",
  volunteers: "Volunteer tasks",
  miSheberach: "Mi Sheberach",
  notKnown: "Not known",
  restricted: "A colleague is caring for this person (restricted).",
  noteHidden: "A private note",
  nothingOpen: "No open care items.",
  print: "Print",
} as const;

export const OUTREACH_WORDS = {
  title: "You might reach out to",
  dismiss: "Not now",
  dismissHelp: "Hides it for 30 days",
} as const;

export const REPORT_WORDS = {
  title: "Numbers",
  period: "Period",
  from: "From",
  to: "To",
  show: "Show",
  nameless: "This is the version without names. A count under 5 shows as \"fewer than 5\".",
  small: "fewer than 5",
  openItems: "Open care items, by kind and how long they have been open",
  firstContact: "Time from a report arriving in the Inbox to the first contact logged",
  journeys: "Journey steps",
  channels: "Where reports come from",
  volunteers: "Volunteer tasks",
  meals: "Meal nights",
  miSheberach: "Mi Sheberach names",
  print: "Print",
} as const;
