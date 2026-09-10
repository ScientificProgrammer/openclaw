function normalizeGoogleChatReplyTarget(params: {
  payload: ReplyPayload;
  sourceMessageName?: string;
  replyThreadName?: string;
}): ReplyPayload {
  const sourceMessageName = params.sourceMessageName;
  if (!sourceMessageName || params.payload.replyToId !== sourceMessageName) {
    return params.payload;
  }
  return { ...params.payload, replyToId: params.replyThreadName };
}
