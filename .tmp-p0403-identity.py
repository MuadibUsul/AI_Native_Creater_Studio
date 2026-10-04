import io

# 1) 服务：锁定旁白用**逻辑 ID**（跨版本身份），而不是行主键
p = 'packages/domain/src/narrative.ts'
s = io.open(p, encoding='utf-8').read()
old = """      : (
          await deps.db
            .select({ id: narrationBlocks.id, text: narrationBlocks.text })
            .from(narrationBlocks)
            .where(and(eq(narrationBlocks.planId, previousPlan.id), eq(narrationBlocks.locked, true)))
            .orderBy(narrationBlocks.position)
        ).map((row) => ({ id: row.id, text: row.text }));"""
new = """      : (
          await deps.db
            .select({ id: narrationBlocks.logicalId, text: narrationBlocks.text })
            .from(narrationBlocks)
            .where(and(eq(narrationBlocks.planId, previousPlan.id), eq(narrationBlocks.locked, true)))
            .orderBy(narrationBlocks.position)
        ).map((row) => ({ id: row.id, text: row.text }));"""
assert s.count(old) == 1, 'locked query'
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('locked query fixed')

# 2) Mock：生成块用独立前缀（nrg_），避免与锁定逻辑 ID（nrb_）冲突
p = 'packages/providers/mock-llm/src/index.ts'
s = io.open(p, encoding='utf-8').read()
old2 = """      narrationBlocks.push({
        id: `nrb_${String(index + 1)}`,"""
new2 = """      narrationBlocks.push({
        id: `nrg_${String(index + 1)}`, // 生成块前缀与锁定块（保留原 id）区分，避免逻辑 ID 冲突
"""
assert s.count(old2) == 1, 'mock ids'
s = s.replace(old2, new2)
old3 = "    '5) narrationBlocks[].id 建议使用 nrb_1..n；chapters[].narrationBlockIds 引用这些 id。',"
new3 = "    '5) 生成旁白块 id 使用 nrg_1..n（锁定旁白沿用其既有 id）；chapters[].narrationBlockIds 引用这些 id。',"
assert s.count(old3) == 1, 'prompt hint'
s = s.replace(old3, new3)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('mock ids fixed')

# 3) repair：防御性去重（真实 LLM 可能输出重复 id）
p = 'packages/domain/src/narrative-repair.ts'
s = io.open(p, encoding='utf-8').read()
old4 = """    const chapterTitle = asString(rawBlock['chapterTitle']) ?? asString(rawBlock['chapterId']) ?? null;
    const chapterId = chapterTitle !== null ? (chapterTitles.get(chapterTitle) ?? null) : null;
    blockIndex += 1;
    blocks.push({
      id,"""
new4 = """    const chapterTitle = asString(rawBlock['chapterTitle']) ?? asString(rawBlock['chapterId']) ?? null;
    const chapterId = chapterTitle !== null ? (chapterTitles.get(chapterTitle) ?? null) : null;
    // 防御性去重：真实模型可能输出重复 id（作为主键/逻辑引用都会冲突）
    let uniqueId = id;
    let suffix = 2;
    while (blocks.some((existing) => existing.id === uniqueId)) {
      uniqueId = `${id}_${String(suffix)}`;
      suffix += 1;
    }
    if (uniqueId !== id) repairs.push(`旁白块 id 重复（${id}）：已重命名为 ${uniqueId}`);
    blockIndex += 1;
    blocks.push({
      id: uniqueId,"""
assert s.count(old4) == 1, 'dedupe'
s = s.replace(old4, new4)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('repair dedupe added')
