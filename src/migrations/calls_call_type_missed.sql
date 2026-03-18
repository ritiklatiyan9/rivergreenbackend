-- Ensure missed phone calls can be stored in calls.call_type.
DO $$
DECLARE
    c RECORD;
BEGIN
    IF to_regclass('public.calls') IS NULL THEN
        RETURN;
    END IF;

    FOR c IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'public.calls'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%call_type%'
    LOOP
        EXECUTE format('ALTER TABLE public.calls DROP CONSTRAINT %I', c.conname);
    END LOOP;

    ALTER TABLE public.calls
      ADD CONSTRAINT calls_call_type_check
      CHECK (call_type IN ('INCOMING', 'OUTGOING', 'MISSED'));
END $$;
