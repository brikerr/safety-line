/**
 * about.ts: what Safety Line says about itself.
 *
 * A question such as "What does this website do?" is not answered by the
 * documents, so searching them only turns up unrelated passages. Those
 * questions get this fixed explanation instead. No search, no model call,
 * and it does not count against the rate limit.
 */
import { sources } from "./sources";

/** The short line shown at the top of the page. */
export const ABOUT_LINE =
  "Safety Line is a reference tool that answers questions about safety guidance for physical and ambient AI. It uses only eight public documents from NIST, NHTSA, the FDA, OSHA and the UK government.";

/** The fixed answer to a question about the app itself. */
export const ABOUT_ANSWER = [
  "Safety Line is a reference tool built by Brian Kerr. It answers questions about safety guidance for physical and ambient AI: systems that sense, decide and act around people, such as vehicles, medical devices and industrial robots.",
  "It answers only from eight public documents and links every claim to the page it came from. When the documents do not cover a question, it says so. It does not give legal, medical, or engineering advice.",
  "The documents are:\n" + sources.map((s) => `- ${s.title} (${s.year})`).join("\n"),
].join("\n\n");

/**
 * Is this a question about the app, not about the documents?
 *
 * Deliberately narrow. It is better to miss an unusual phrasing (the model
 * prompt has its own rule for those) than to hijack a real question.
 */
const ABOUT_PATTERNS = [
  // names the app
  /\bsafety line\b/i,
  // "what does this website do", "how does this tool work", "who made this site"
  /\b(what|how|who|why|which)\b.*\b(this|your) (web ?site|site|app|tool|page|chatbot|bot|assistant)\b/i,
  // whole-message questions aimed at the app: "what is this?", "what can you do?"
  /^(what (is|are) (this|you)|what (can|do) you do|who (are you|made this|built this)|how (do you|does this|does it) work|what (documents|sources) (do you|does this|does it) use)[\s?.!]*$/i,
];

export function isAboutQuestion(question: string): boolean {
  return ABOUT_PATTERNS.some((pattern) => pattern.test(question.trim()));
}
