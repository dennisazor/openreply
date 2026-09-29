import { inflateSync } from "node:zlib";

// Metadata and object streams are small; anything bigger is not worth inflating.
const MAX_INFLATED_BYTES = 16 * 1024 * 1024;

/**
 * Detects Microsoft Purview sensitivity labels (MSIP_Label_* metadata) in a
 * file before it is published.
 *
 * Files stored in a Microsoft 365 OneDrive can pick up a label such as
 * "Confidential \ Any User (No Protection)" without any visible change. The label
 * travels inside the PDF, so publishing it exposes the organization's label
 * names and tenant ID to anyone who downloads the file.
 *
 * Returns the label's display name, a generic name if the value can't be read,
 * or null when the file is clean.
 */
export function findSensitivityLabel(bytes: Uint8Array): string | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = buffer.toString("latin1");

  const direct = readLabelName(text);
  if (direct !== null) return direct;

  // PDF 1.5+ can keep the document info inside a compressed object stream and
  // the XMP packet inside a compressed metadata stream. Only those two stream
  // types are inflated, so fonts and images don't cost anything.
  const streamStart = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = streamStart.exec(text)) !== null) {
    const start = match.index + match[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) break;
    // Resume after "endstream": the word contains "stream", and matching inside
    // it would swallow the next object's real stream.
    streamStart.lastIndex = end + "endstream".length;

    const dictionary = text.slice(Math.max(0, text.lastIndexOf("obj", match.index)), match.index);
    if (!/\/Type\s*\/(ObjStm|Metadata)\b/.test(dictionary)) continue;

    try {
      const inflated = inflateSync(buffer.subarray(start, end), {
        maxOutputLength: MAX_INFLATED_BYTES,
      }).toString("latin1");
      const found = readLabelName(inflated);
      if (found !== null) return found;
    } catch {
      // Uncompressed or not Flate-encoded; the direct scan already covered it.
    }
  }

  return null;
}

const GENERIC_NAME = "Microsoft sensitivity label";

function readLabelName(text: string): string | null {
  if (!text.includes("MSIP_Label_")) return null;

  const names = [
    // XMP form: <msip:MSIP_Label_<guid>_Name>Confidential</...>
    ...Array.from(text.matchAll(/MSIP_Label_[0-9a-fA-F-]+_Name>([^<]+)</g), (m) => m[1]),
    // Info dictionary form: /MSIP_Label_<guid>_Name (Confidential \\ Any User \(No Protection\))
    ...Array.from(
      text.matchAll(/MSIP_Label_[0-9a-fA-F-]+_Name\s*\(((?:\\.|[^\\)])*)\)/g),
      (m) => m[1].replace(/\\(.)/g, "$1")
    ),
  ]
    .map((name) => name.trim())
    .filter(Boolean);

  // A sub-label ("Confidential \ Any User") is stored next to its parent
  // ("Confidential"); the longer name is the specific one.
  return names.sort((a, b) => b.length - a.length)[0] ?? GENERIC_NAME;
}
