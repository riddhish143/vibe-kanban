/**
 * Strips boilerplate prefixes that were added by the GitHub import feature
 * to issue descriptions and comments. The data is already in the database so
 * we strip at display time.
 *
 * Issue description prefix pattern:
 *   "Imported from GitHub\nRepository: ...\nIssue: #...\nSource: ...\n\n<body>"
 *
 * Comment prefix pattern:
 *   "Imported from GitHub comment by @... on ...\nSource: ...\n\n<body>"
 */
export function stripGitHubImportPrefix(text: string | null | undefined): string | null | undefined {
  if (!text) return text;

  // Match the "Imported from GitHub\n...\n\n" header block (description)
  const descMatch = text.match(/^Imported from GitHub\n[\s\S]*?\n\n/);
  if (descMatch) {
    return text.slice(descMatch[0].length) || null;
  }

  // Match the "Imported from GitHub comment by ...\n\n" header block (comments)
  const commentMatch = text.match(/^Imported from GitHub comment by [\s\S]*?\n\n/);
  if (commentMatch) {
    return text.slice(commentMatch[0].length) || null;
  }

  return text;
}
