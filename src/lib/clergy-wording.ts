/** The words of the clergy tools: the agenda, away and cover, search in notes, the hospital list. One place, plain wording. */
export const AGENDA_WORDS = {
  title: "Clergy agenda",
  nav: "Agenda",
  add: "Add to this week’s agenda",
  addTitle: "Add to this week’s agenda",
  why: "Why (one line, optional)",
  freeText: "What to talk about",
  restrictedWarning: "This is about a restricted item. Only its owner and the clergy named on it will see this entry. Everyone else will not see that it exists.",
  freeTextHint: "Every clergy member sees this line. Do not name a restricted matter here.",
  toDiscuss: "To discuss",
  nextWeek: "Carried to next week",
  discussed: "Discussed in the last two weeks",
  empty: "Nothing on the agenda yet. Add a person or a care item from their page, or a line of your own here.",
  printLink: "Print for the meeting",
  discuss: "Discussed",
  discussTitle: "Mark as discussed",
  outcome: "What came of it (one line, optional)",
  makeFollowUp: "Make a follow-up for",
  nobody: "No follow-up",
  carry: "Carry to next week",
  remove: "Remove",
  addedBy: "Added by",
} as const;

export const AWAY_WORDS = {
  title: "I’m away",
  intro: "While you are away, Today, the team view and the Inbox say so, and a colleague you name sees your follow-ups due in those days. Nothing is reassigned: it all comes back to you by itself when you return.",
  from: "Away from",
  until: "Until",
  cover: "Covered by",
  nobody: "No one",
  save: "Save",
  clear: "I’m back",
  coveringFor: (name: string) => `Covering for ${name}`,
  coveringNone: "Nothing of theirs is due in these days.",
} as const;

export const FIND_WORDS = {
  people: "People",
  notes: "In notes",
  notesLabel: "Words to look for",
  notesHint: "Searches the notes, summaries, follow-ups and agenda you are allowed to read. At least three letters.",
  notesNone: "Nothing found. Try other words or a shorter beginning of a word.",
  more: "Load more",
} as const;

export const VISITS_WORDS = {
  title: "In hospital now",
  link: "In hospital now",
  intro: "Open illness care that you can see, by where the person is.",
  plan: "Plan a round",
  visited: "Visited",
  visitedToday: "Visited today",
  since: "Since",
  lastContact: "Last contact",
  nextFollowUp: "Next follow-up",
  none: "None",
  where: "Where are they?",
  whereHint: "No place is set for these.",
  placePlaceholder: "Hospital and room",
  setPlace: "Set place",
  empty: "No one is in hospital on your list.",
  print: "Print",
} as const;

export const OUTSIDE_EDIT_WORDS = {
  link: "Edit details",
  title: "Edit details",
  save: "Save",
} as const;

export const THANK_WORDS = {
  toldBy: "Told to us by",
  thank: "Thank them",
  hint: "Opens your own mail app with a short message you can change. Nothing is sent from here.",
} as const;
