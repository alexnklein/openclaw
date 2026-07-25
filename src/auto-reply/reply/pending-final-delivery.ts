/** Sanitizes pending final delivery text before channel-visible output. */
import {
  isSilentReplyPayloadText,
  isSilentReplyText,
  SILENT_REPLY_RECEIPT_TEXT,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../tokens.js";
import { stripInternalMetadataForDisplay } from "./display-text-sanitize.js";

/** Sanitizes final pending-delivery text and removes silent control tokens. */
export function sanitizePendingFinalDeliveryText(text: string): string {
  let stripped = stripInternalMetadataForDisplay(text).trim();
  const hadSilentReplyToken = stripped.toLowerCase().includes(SILENT_REPLY_TOKEN.toLowerCase());
  if (isSilentReplyPayloadText(stripped, SILENT_REPLY_TOKEN)) {
    return SILENT_REPLY_RECEIPT_TEXT;
  }
  if (stripped && !isSilentReplyText(stripped, SILENT_REPLY_TOKEN)) {
    const hasLeadingSilentToken = startsWithSilentToken(stripped, SILENT_REPLY_TOKEN);
    if (hasLeadingSilentToken) {
      stripped = stripLeadingSilentToken(stripped, SILENT_REPLY_TOKEN);
    }
    // Remove stray silent tokens only after confirming the payload is not entirely silent.
    if (
      hasLeadingSilentToken ||
      stripped.toLowerCase().includes(SILENT_REPLY_TOKEN.toLowerCase())
    ) {
      stripped = stripSilentToken(stripped, SILENT_REPLY_TOKEN);
    }
  }
  if (!stripped.trim()) {
    if (hadSilentReplyToken) {
      return SILENT_REPLY_RECEIPT_TEXT;
    }
    return "";
  }
  return isSilentReplyPayloadText(stripped, SILENT_REPLY_TOKEN)
    ? SILENT_REPLY_RECEIPT_TEXT
    : stripped.trim();
}
