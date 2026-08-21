import { sha256Hex } from "../../packages/core/src/index.ts";

/**
 * HaluMem official prompts — locked from MemTensor/HaluMem eval/ (Appendix C).
 * Answer: adapted PROMPT_MEMZERO for df-memory retrieval context.
 * Judge: verbatim from eval/eval_tools.py (C.2).
 */

/** df-memory C.1 answer (MemZero structure + df-memory context wrapper). */
export const HALUMEM_ANSWER_TEMPLATE = `You are an intelligent memory assistant tasked with retrieving accurate information from conversation memories.

# CONTEXT:
You have access to memories from two speakers in a conversation. These memories contain
timestamped information that may be relevant to answering the question.

# INSTRUCTIONS:
1. Carefully analyze all provided memories from both speakers
2. Pay special attention to the timestamps to determine the answer
3. If the question asks about a specific event or fact, look for direct evidence in the memories
4. If the memories contain contradictory information, prioritize the most recent memory
5. If there is a question about time references (like "last year", "two months ago", etc.),
calculate the actual date based on the memory timestamp. For example, if a memory from
4 May 2022 mentions "went to India last year," then the trip occurred in 2021.
6. Always convert relative time references to specific dates, months, or years. For example,
convert "last year" to "2022" or "two months ago" to "March 2023" based on the memory
timestamp. Ignore the reference while answering the question.
7. Focus only on the content of the memories from both speakers. Do not confuse character
names mentioned in memories with the actual users who created those memories.
8. The answer should be less than 5-6 words.

# APPROACH (Think step by step):
1. First, examine all memories that contain information related to the question
2. Examine the timestamps and content of these memories carefully
3. Look for explicit mentions of dates, times, locations, or events that answer the question
4. If the answer requires calculation (e.g., converting relative time references), show your work
5. Formulate a precise, concise answer based solely on the evidence in the memories
6. Double-check that your answer directly addresses the question asked
7. Ensure your final answer is specific and avoids vague time references

{context}

Question: {question}

Answer:`;

export const HALUMEM_INTEGRITY_JUDGE = `You are a strict **"Memory Integrity" evaluator**.
Your core task is to assess whether an AI memory system has **missed any key memory points** after processing a conversation. This evaluation measures the system's **memory integrity**, i.e., its ability to resist **amnesia** or **omission**.

# Evaluation Context & Data:

1. **Extracted Memories:**
 These are all the memory items actually extracted by the memory system.
 {memories}

2. **Expected Memory Point:**
 The key memory point that *should* have been extracted.
 {expected_memory_point}

# Evaluation Instructions:

1. For each **Expected Memory Point**, search within the **Extracted Memories** list for corresponding or related information. Ignore unrelated items.
2. Based on the following scoring rubric, rate how well the memory system captured the **Expected Memory Point** and provide a detailed explanation.

# Scoring Rubric:

* **2:** Fully covered or implied.
 One or more items in "Extracted Memories" fully cover or logically imply all information in the "Expected Memory Point."

* **1:** Partially covered or mentioned.
 Some information in "Extracted Memories" mentions part of the "Expected Memory Point," but key information is missing, inaccurate, or slightly incorrect.

* **0:** Not mentioned or incorrect.
 "Extracted Memories" contains no mention of the "Expected Memory Point," or the corresponding information is entirely wrong.

# Scoring Notes:

* For **compound Expected Memory Points** (with multiple elements such as person/event/time/location/preference, etc.):

 * All elements correct → **2 points**
 * Some elements correct / uncertain → **1 point**
 * Key elements missing or wrong → **0 points**

* Semantic matching is acceptable; exact wording is **not** required.

* If "Extracted Memories" contains **conflicting information**, assign the **best possible coverage score** and mention the conflict in your reasoning.

* Extra or stylistically different memories do **not** reduce the score; only the coverage of the **Expected Memory Point** matters.

* For uncertain wording ("might," "probably," "tends to," etc.):

 * If the Expected Memory Point is a definite statement, usually assign **1 point**.

* If critical fields (e.g., time, entity name, relationship) are partly wrong but others match → **1 point**.

 * If all key fields are wrong or missing → **0 points**.

# Output Format:

Please output your result in the following JSON format:

\`\`\`json
{
  "reasoning": "Provide a concise justification for the score",
  "score": "2|1|0"
}
\`\`\``;

export const HALUMEM_UPDATE_JUDGE = `Your task is to **evaluate the update accuracy** of an AI memory system.
Based on the information provided below, determine whether the system-generated **"Generated Memories"** correctly **includes** the **Target Memory for Update**.

# Background Information

The following information is provided for evaluation:

1. **Generated Memories:**
 This is the list of memory points generated by the system after the current dialogue.
 {memories}

2. **Target Memory for Update:**
 This is the correct, updated version of the memory point that should have been produced — the one we focus on in this evaluation.
 {updated_memory}

3. **Original Memory Content:**
 This is the original version of the target memory before the update.
 {original_memory}

# Evaluation Criteria

Please make your judgment **strictly based on the content update of the "Target Memory for Update."**
Use the following categories:

### Correct Update

* **Generated Memories** **contains all information points** from the "Target Memory for Update," accurately and completely reflecting the intended update.
* **Key fields** (e.g., date, time, values, proper nouns, etc.) must match exactly.
* The **original memory** is effectively replaced or marked as outdated.
* Synonymous or slightly rephrased expressions are acceptable.

### Hallucinated Update

* **Factual error:** The **Generated Memories** includes a new memory related to the "Target Memory for Update," but its content contains factual mistakes or contradictions compared to the correct update.

### Omitted Update

* **Completely omitted:** The **Generated Memories** contains no new memory related to the "Target Memory for Update."
* **Partially omitted:** A related new memory was generated in **Generated Memories**, but it **misses key information** that should have been included.

### Other

Used for update failures that do **not clearly fall** into the above categories of "Hallucination" or "Omission."

# Output Requirements

Please return your evaluation strictly in the following JSON format and provide a concise explanation.

\`\`\`json
{
  "reason": "Briefly explain your reasoning here and why it fits this category.",
  "evaluation_result": "Correct | Hallucination | Omission | Other"
}
\`\`\``;

export const HALUMEM_QA_JUDGE = `You are an **evaluation expert for AI memory system question answering**.
Based **only** on the provided **"Question"**, **"Reference Answer"**, and **"Key Memory Points"** (the essential facts needed to derive the reference answer), strictly evaluate the **accuracy** of the **"Memory System Response."** Classify it as one of **"Correct"**, **"Hallucination"**, or **"Omission."** Do **not** use any external knowledge or subjective inference. Finally, output your judgment **strictly** in the specified JSON format.

# Evaluation Criteria

## Answer Type Classification

### 1. Correct

* The "Memory System Response" accurately answers the "Question," and its content is **semantically equivalent** to the "Reference Answer."
* It contains **no contradictions** with the "Key Memory Points" or "Reference Answer."
* It introduces **no unsupported details** beyond the "Key Memory Points" that could alter the conclusion.
* Synonyms, paraphrasing, and reasonable summarization are acceptable.

### 2. Hallucination

* The "Memory System Response" includes information or facts that **contradict or are inconsistent** with the "Reference Answer" or the "Key Memory Points."
* When the "Reference Answer" is labeled as *unknown/uncertain*, yet the response provides a specific verifiable fact or conclusion.
* Extra irrelevant information that does **not change** the conclusion is **not** considered hallucination by itself; however, if it **changes or misleads** the conclusion, or **contradicts** the "Key Memory Points," it should be judged as a **Hallucination**.

### 3. Omission

* The response is **incomplete** compared to the "Reference Answer."
* It explicitly states "don't know," "can't remember," or "no related memory," even though relevant information exists in the "Key Memory Points."
* For multi-element questions, **all elements must be correct and present**; omission of **any** element is considered an **Omission**.

## Priority Rules (Conflict Handling)

* If the response contains **both missing necessary information** and **fabricated/contradictory information**, classify it as **Hallucination**.
* If there is **no fabrication/contradiction** but some necessary information is missing, classify it as **Omission**.
* Only when the meaning is **fully equivalent** to the reference answer should it be classified as **Correct**.

# Information for Evaluation

* **Question:**
 {question}

* **Reference Answer:**
 {reference_answer}

* **Key Memory Points:**
 {key_memory_points}

* **Memory System Response:**
 {response}

# Output Requirements

Please provide your evaluation result **strictly** in the JSON format below.
Do **not** add any extra explanation or comments outside the JSON block.

\`\`\`json
{
  "reasoning": "Provide a concise and traceable evaluation rationale: first compare the system's response with the Key Memory Points (which were correctly used, which were missing, and whether there was any fabrication/contradiction), then assess its consistency with the Reference Answer, and finally state the classification basis.",
  "evaluation_result": "Correct | Hallucination | Omission"
}
\`\`\``;

export type HaluMemProtocol = "halumem-official-v1" | "halumem-v1";

export const HALUMEM_OFFICIAL_QA_TOP_K = 20;
export const HALUMEM_OFFICIAL_UPDATE_TOP_K = 10;

export function halumemOfficialPromptHash(): {
  answer: string;
  integrity: string;
  update: string;
  qa: string;
} {
  return {
    answer: sha256Hex(HALUMEM_ANSWER_TEMPLATE),
    integrity: sha256Hex(HALUMEM_INTEGRITY_JUDGE),
    update: sha256Hex(HALUMEM_UPDATE_JUDGE),
    qa: sha256Hex(HALUMEM_QA_JUDGE),
  };
}

export function formatOfficialAnswerPrompt(
  question: string,
  context: string,
): { system: string; prompt: string } {
  const prompt = HALUMEM_ANSWER_TEMPLATE.replace("{context}", context).replace("{question}", question);
  return { system: "", prompt };
}

export function formatOfficialQaJudgePrompt(
  question: string,
  referenceAnswer: string,
  keyMemoryPoints: string,
  response: string,
): { system: string; prompt: string } {
  const prompt = HALUMEM_QA_JUDGE.replace("{question}", question)
    .replace("{reference_answer}", referenceAnswer)
    .replace("{key_memory_points}", keyMemoryPoints)
    .replace("{response}", response);
  return { system: "", prompt };
}

export function formatOfficialIntegrityJudgePrompt(
  extractedMemories: string,
  expectedMemoryPoint: string,
): { system: string; prompt: string } {
  const prompt = HALUMEM_INTEGRITY_JUDGE.replace("{memories}", extractedMemories).replace(
    "{expected_memory_point}",
    expectedMemoryPoint,
  );
  return { system: "", prompt };
}

export function formatOfficialUpdateJudgePrompt(
  generatedMemories: string,
  updatedMemory: string,
  originalMemory: string,
): { system: string; prompt: string } {
  const prompt = HALUMEM_UPDATE_JUDGE.replace("{memories}", generatedMemories)
    .replace("{updated_memory}", updatedMemory)
    .replace("{original_memory}", originalMemory);
  return { system: "", prompt };
}

/** Official QA context wrapper (eval_memzero.py). */
export function formatOfficialRetrievalContext(userId: string, memoryLines: string[]): string {
  const body =
    memoryLines.length === 0
      ? "(none)"
      : memoryLines.map((m) => `- ${m}`).join("\n");
  return `Memories for user ${userId}:\n\n${body}`;
}

export function keyMemoryPointsFromQuestion(qa: {
  answer: string;
  evidence?: Array<{ memory_content: string }>;
}): string {
  const ev = qa.evidence?.map((e) => e.memory_content.trim()).filter(Boolean) ?? [];
  if (ev.length > 0) return ev.join("\n");
  return qa.answer;
}
