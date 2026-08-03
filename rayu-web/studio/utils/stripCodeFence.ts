/**
 * Strip the markdown code fences a model sometimes wraps around a bolt artifact.
 *
 * Models are prone to emitting the artifact element inside a ```xml fence, which
 * would render as literal markup instead of being parsed as an artifact.
 *
 * WHY THIS LIVES IN ITS OWN MODULE
 *
 * It was defined in components/chat/Markdown.tsx, which imports react-markdown and
 * therefore the whole ESM-only unified/remark/rehype/micromark stack. Its unit test
 * needs none of that, but importing the component pulled all of it into Jest's
 * CommonJS runtime and failed to parse. Pure logic separated from the render path
 * is testable without a bundler — and Markdown.tsx re-exports this so nothing that
 * imported it from there had to change.
 */
export const stripCodeFenceFromArtifact = (content: string): string => {
  if (!content || !content.includes('__boltArtifact__')) {
    return content;
  }

  const lines = content.split('\n');
  const artifactLineIndex = lines.findIndex((line) => line.includes('__boltArtifact__'));

  // Return original content if artifact line not found
  if (artifactLineIndex === -1) {
    return content;
  }

  // Check previous line for code fence
  if (artifactLineIndex > 0 && lines[artifactLineIndex - 1]?.trim().match(/^```\w*$/)) {
    lines[artifactLineIndex - 1] = '';
  }

  if (artifactLineIndex < lines.length - 1 && lines[artifactLineIndex + 1]?.trim().match(/^```$/)) {
    lines[artifactLineIndex + 1] = '';
  }

  return lines.join('\n');
};
