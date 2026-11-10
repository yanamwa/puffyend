export function hasPendingProfessorTutorial(user) {
  return (
    String(user.role || "")
      .trim()
      .toLowerCase() === "professor" &&
    Number(user.professor_tutorial_pending) === 1
  );
}
