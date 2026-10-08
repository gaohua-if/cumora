import { createHash } from 'node:crypto'

export const AIDA_MESSAGE_ROUTING_SQL = `
ALTER TABLE messages ADD COLUMN work_recipient_ids TEXT[];

CREATE FUNCTION cumora_exact_mention(body TEXT, target TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE remaining TEXT := lower(COALESCE(body,'')); needle TEXT := '@'||lower(COALESCE(target,'')); at INTEGER;
BEGIN
  IF target IS NULL OR target='' THEN RETURN FALSE; END IF;
  LOOP
    at := strpos(remaining,needle);
    IF at=0 THEN RETURN FALSE; END IF;
    IF (at=1 OR substring(remaining,at-1,1) !~ '[[:alnum:]_@]')
      AND substring(remaining,at+length(needle),1) !~ '[[:alnum:]_-]' THEN RETURN TRUE; END IF;
    remaining := substring(remaining,at+1);
  END LOOP;
END;
$$;

CREATE FUNCTION cumora_message_recipients(channel TEXT, author TEXT, body TEXT, quoted TEXT) RETURNS TEXT[]
LANGUAGE SQL STABLE AS $$
  WITH roster AS (
    SELECT p.id,p.name,b.alias,COALESCE(b.is_default,FALSE) AS is_default,cm.ordinal,c.kind
    FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.company_id=c.company_id
    JOIN participants p ON p.id=cm.participant_id AND p.company_id=c.company_id AND p.kind='agent' AND p.departed_at IS NULL
    LEFT JOIN channel_agent_bindings b ON b.company_id=c.company_id AND b.conversation_id=c.id AND b.agent_id=p.id AND b.status='ACTIVE'
    WHERE c.id=channel
  ), named AS (
    SELECT r.id FROM roster r WHERE cumora_exact_mention(body,r.id) OR cumora_exact_mention(body,r.name)
      OR cumora_exact_mention(body,r.alias) OR r.id=(SELECT m.author_id FROM messages m WHERE m.id=quoted AND m.conversation_id=channel)
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

CREATE FUNCTION cumora_store_message_recipients() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.work_recipient_ids := CASE WHEN NEW.kind='system' THEN NULL
    ELSE cumora_message_recipients(NEW.conversation_id,NEW.author_id,NEW.body,NEW.quoted_message_id) END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER message_work_recipients BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION cumora_store_message_recipients();

UPDATE messages SET work_recipient_ids=cumora_message_recipients(conversation_id,author_id,body,quoted_message_id)
  WHERE kind<>'system';
`

export function aidaMessageRoutingChecksum(): string {
  return createHash('sha256').update(AIDA_MESSAGE_ROUTING_SQL).digest('hex')
}
