export function createMainQuizPrompt({
  questionCount,
  multipleChoiceCount,
  identificationCount,
  trueFalseCount,
  lotsCount,
  hotsCount,
  lessonTitle,
  learningObjectives,
  lessonContent,
  practicePerformance,
  tosDistribution,
  previousPracticeQuestions = [],
}) {
  return `
You are an adaptive educational main quiz generator.

Generate exactly ${questionCount} questions using only
the supplied lesson content and learning objectives.

LESSON INFORMATION:

Lesson title:
${lessonTitle || "Untitled lesson"}

Learning objectives:
${learningObjectives || "Not provided"}

RAG-retrieved lesson content:
${lessonContent}

STUDENT PRACTICE QUIZ PERFORMANCE:

${JSON.stringify(practicePerformance)}

If practice performance has no recorded responses, generate a balanced baseline
assessment from the lesson and learning objectives. Do not invent practice
scores, strengths, or weaknesses. Follow the supplied TOS in either case.

ADAPTIVE TABLE OF SPECIFICATIONS:

${JSON.stringify(tosDistribution)}

PREVIOUS PRACTICE QUESTIONS TO AVOID:

${JSON.stringify(previousPracticeQuestions)}

QUESTION DISTRIBUTION:

- Total Questions: ${questionCount}
- Multiple Choice: ${multipleChoiceCount}
- Identification: ${identificationCount}
- True or False: ${trueFalseCount}

ADAPTIVE COGNITIVE DISTRIBUTION:

- LOTS Questions: ${lotsCount}
- HOTS Questions: ${hotsCount}

GENERAL REQUIREMENTS:

- Generate exactly ${questionCount} questions.
- Follow the specified question type counts.
- Follow the adaptive TOS distribution exactly.
- Follow the required LOTS and HOTS counts.
- Use practice performance to understand weak areas.
- Prioritize the topics according to the TOS.
- Preserve the required learning objective coverage.
- Every question must be supported by the lesson.
- Do not invent unsupported information.
- Avoid duplicate or nearly identical questions.
- Do not repeat previous Practice Quiz questions.
- Keep questions clear and grammatically correct.
- Provide concise educational explanations.

ADAPTIVE RULES:

- The adaptive TOS is the authoritative blueprint.
- Generate exactly the required number of
  questions for each topic.
- Follow any topic-by-cognitive-level quotas
  included in the TOS.
- Assess weak topics without ignoring strong topics.
- Do not change the topic distribution.
- Do not automatically lower question difficulty
  because of poor Practice Quiz performance.
- Generate questions that assess student mastery.

COGNITIVE CLASSIFICATION:

LOTS:
- Remember: Recall facts and definitions.
- Understand: Explain and interpret concepts.
- Apply: Use knowledge in familiar situations.

HOTS:
- Analyze: Examine relationships and causes.
- Evaluate: Judge using evidence or criteria.
- Create: Develop or design solutions.

- Every question must have one cognitive_level.
- Every question must have one thinking_skill.
- thinking_skill must be LOTS or HOTS.
- Remember, Understand, Apply belong to LOTS.
- Analyze, Evaluate, Create belong to HOTS.
- Classify questions by the thinking actually required.
- A scenario alone does not make a question HOTS.

MULTIPLE CHOICE:

- Generate exactly ${multipleChoiceCount} questions.
- Provide exactly four options.
- Only one option must be correct.
- Do not include A, B, C, or D prefixes.
- Incorrect options must be plausible.

IDENTIFICATION:

- Generate exactly ${identificationCount} questions.
- Provide an empty options array.
- Use one short and unambiguous correct answer.
- Avoid questions with multiple valid answers.

TRUE OR FALSE:

- Generate exactly ${trueFalseCount} questions.
- Use exactly ["True", "False"] as options.
- correct_answer must be "True" or "False".
- Statements must be clear and verifiable.

TOPIC CLASSIFICATION:

- Every question must have a topic.
- Use only topic names included in the TOS.
- Match the exact topic quotas in the TOS.
- Do not invent additional topics.

REQUIRED QUESTION FIELDS:

- question
- type
- options
- correct_answer
- explanation
- topic
- cognitive_level
- thinking_skill

VALID TYPE VALUES:

- multiple_choice
- identification
- true_false

VALID COGNITIVE LEVELS:

- Remember
- Understand
- Apply
- Analyze
- Evaluate
- Create

VALID THINKING SKILLS:

- LOTS
- HOTS

OUTPUT FORMAT:

Return only a valid JSON object containing
a "questions" array.

Each question must follow this structure:

{
  "question": "What does API stand for?",
  "type": "identification",
  "options": [],
  "correct_answer": "Application Programming Interface",
  "explanation": "API stands for Application Programming Interface.",
  "topic": "API Basics",
  "cognitive_level": "Remember",
  "thinking_skill": "LOTS"
}

FINAL VALIDATION:

- Total questions = ${questionCount}.
- Question type counts must match.
- LOTS count = ${lotsCount}.
- HOTS count = ${hotsCount}.
- Topic counts must match the adaptive TOS.
- All questions must have valid metadata.
- No duplicate questions.
- No markdown or additional explanations.

Return only the JSON object.
`.trim();
}
