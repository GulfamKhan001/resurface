-- Checkpoints must not outlive the code that produced them.
--
-- Found the first time the real extractor ran: the resumability test had left
-- seven chunks marked done, carrying its fake {idx, words} results. The resume
-- logic did exactly what it was built to do — skipped the completed chunks — and
-- the run produced zero items while reporting 7/7 done and $0 spent.
--
-- That is the dangerous shape again: a correct mechanism producing a confidently
-- wrong result. A checkpoint is only valid for the extractor that wrote it, so
-- the version travels with the row and a mismatch means the chunk is not done.
alter table chunks add column if not exists extractor_version text not null default 'v0';

-- Anything written before this column existed came from the fake extractor or an
-- older prompt, so it cannot be trusted as a checkpoint.
delete from chunks where extractor_version = 'v0';
