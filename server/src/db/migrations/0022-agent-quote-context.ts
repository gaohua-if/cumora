import { createHash } from 'node:crypto'

/** Agent quotes carry reply context, while explicit mentions carry delegation. */
export const AGENT_QUOTE_CONTEXT_SQL = `
CREATE OR REPLACE FUNCTION cumora_message_recipients(channel TEXT, author TEXT, body TEXT, quoted TEXT) RETURNS TEXT[]
LANGUAGE SQL STABLE AS $$
  WITH roster AS (
    SELECT p.id,p.name,b.alias,COALESCE(b.is_default,FALSE) AS is_default,cm.ordinal,c.kind
    FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.company_id=c.company_id
    JOIN participants p ON p.id=cm.participant_id AND p.company_id=c.company_id AND p.kind='agent' AND p.departed_at IS NULL
    LEFT JOIN channel_agent_bindings b ON b.company_id=c.company_id AND b.conversation_id=c.id AND b.agent_id=p.id AND b.status='ACTIVE'
    WHERE c.id=channel
  ), named AS (
    SELECT r.id FROM roster r WHERE cumora_exact_mention(body,r.id) OR cumora_exact_mention(body,r.name)
      OR cumora_exact_mention(body,r.alias) OR (r.id=(SELECT m.author_id FROM messages m WHERE m.id=quoted AND m.conversation_id=channel)
        AND EXISTS(SELECT 1 FROM participants sender JOIN conversations c ON c.company_id=sender.company_id
          WHERE c.id=channel AND sender.id=author AND sender.kind='human'))
  ), responsible AS (
    SELECT id FROM roster WHERE is_default OR lower(name)='aida' OR (SELECT count(*) FROM roster)=1
    ORDER BY is_default DESC,(lower(name)='aida') DESC,ordinal,id LIMIT 1
  )
  SELECT ARRAY(SELECT r.id FROM roster r WHERE r.id<>author AND (
    r.kind='direct' OR cumora_exact_mention(body,'all')
    OR CASE WHEN EXISTS(SELECT 1 FROM named) THEN r.id IN(SELECT id FROM named)
      ELSE r.id IN(SELECT id FROM responsible) END
  ) ORDER BY r.ordinal,r.id);
$$;

`

export function agentQuoteContextChecksum(): string {
  return createHash('sha256').update(AGENT_QUOTE_CONTEXT_SQL).digest('hex')
}
