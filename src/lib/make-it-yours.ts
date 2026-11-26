/**
 * Where the shared code and its setup guide live, and what a visitor pastes into their own
 * assistant (src/app/demo/own). The shared project is called Chesed; its public repository is
 * written from this one on every change to main (scripts/public-export).
 */
export const PROJECT_NAME = "Chesed";
export const REPO_URL = "https://github.com/RavBogard/chesed-care";
export const GUIDE_URL = "https://raw.githubusercontent.com/RavBogard/chesed-care/main/docs/MAKE-IT-YOURS.md";
export const DEMO_URL = "https://beit-dugma-care.vercel.app/demo";

export const OWN_PROMPT = `I want my own copy of ${PROJECT_NAME}, a pastoral care app, for my congregation. I tried its demo here: ${DEMO_URL}

Please read the setup guide at ${GUIDE_URL} and follow it. The code is at ${REPO_URL}.

I am not a programmer and I do not have a GitHub account. Start with the questions in the guide, one at a time. Tell me what a step costs before we do it, and never ask me to paste a password or a real congregant's details into this chat.`;
