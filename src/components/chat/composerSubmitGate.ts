export function hasPendingComposerAttachment(
  pasting: boolean | undefined,
  pendingAttachmentCount: number,
): boolean {
  return pasting === true || pendingAttachmentCount > 0;
}

export function shouldSubmitComposerOnKeyDown(
  key: string,
  shiftKey: boolean,
  canSend: boolean,
  isComposing = false,
): boolean {
  return !isComposing && key === 'Enter' && !shiftKey && canSend;
}
