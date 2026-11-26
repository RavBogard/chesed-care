/** The words of the Settings block for the iPhone Shortcut. Each is listed for Daniel in the pull request. */
export const SHORTCUT_TITLE = "iPhone Shortcut";
export const SHORTCUT_INTRO = "Speak a note to your phone and it arrives here, as if you had typed it into Quick capture. Make a personal key, then build the Shortcut with the steps below. You can have up to three keys, and you can end any of them at any time.";
export const SHORTCUT_NONE = "You have no keys yet.";
export const SHORTCUT_MAKE = "Make a new key";
export const SHORTCUT_FULL = "You have three keys, the most there can be. End one to make another.";
export const SHORTCUT_SHOWN_ONCE = "Copy this key now. It is shown only once, and it cannot be found again.";
export const SHORTCUT_REVOKE_TITLE = "End this key?";
export const SHORTCUT_REVOKE_EXPLAIN = "A Shortcut that uses this key will stop working at once. You can make a new key at any time.";
export const SHORTCUT_STEPS_TITLE = "Build the Shortcut";
export const SHORTCUT_STEPS = [
  "Open the Shortcuts app on your iPhone and tap the plus to make a new shortcut. Name it, for example, Tell Care.",
  "Add the action Dictate Text.",
  "Add the action Get Contents of URL. Set its URL to the address below, then tap Show More.",
  "Set Method to POST. Under Headers, add one: the name Authorization, and the value Bearer, a space, then your key.",
  "Set Request Body to JSON. Add one field of type Text, named text, and choose Dictated Text as its value.",
  "Optional: add it to your Home Screen, or say Hey Siri and its name.",
] as const;
export const SHORTCUT_AFTER = "A note sent this way is handled like one you type into Quick capture. The words are never put in an email or a log.";
export const TELL_SIGN_TITLE = "Sign for the public form";
export const TELL_SIGN_HELP = "A page to print, with a QR code that opens the form where anyone can let the clergy know about someone who needs care.";
export const TELL_SIGN_LINK = "Open the sign";
