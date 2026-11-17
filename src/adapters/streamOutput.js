export function hasGeneratedStreamOutput(event) {
  const delta = event?.choices?.[0]?.delta;
  if (!delta) return false;

  const hasContent = typeof delta.content === 'string' && delta.content.length > 0;
  const hasToolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
  return hasContent || hasToolCalls;
}
