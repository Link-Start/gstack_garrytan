export function readinessVerdictProblems(kind: 'ready' | 'unknown', output: string): string[] {
  const problems: string[] = [];
  if (kind === 'unknown') {
    if (!/unknown|unverified|retry|could not verify/i.test(output)) problems.push('unknown status not reported');
    if (!/\bCapability\s*[.: ]+\s*WARN\b|\b(?:gbrain\s+status|verdict)\s*:\s*YELLOW\b/i.test(output))
      problems.push('unknown result lacks WARN/YELLOW verdict');
    if (/\b(?:gbrain\s+status|verdict)\s*:\s*GREEN\b|\bCapability\s*[.: ]+\s*OK\b/i.test(output))
      problems.push('unknown result claims GREEN or capability OK');
  }
  for (const claim of output.matchAll(/\b(?:semantic search|writes?|write readiness|write availability)[^.!?\n]{0,60}\b(?:ready|verified|proven|confirmed|working)\b/gi)) {
    if (!/\b(?:not|never|without|unknown|unverified)\b/i.test(claim[0]))
      problems.push('read-only check claims semantic search or write readiness');
  }
  return problems;
}
