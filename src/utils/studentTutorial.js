export function hasPendingStudentTutorial(user) {
  return (
    String(user.role || "").trim().toLowerCase() === "student" &&
    Number(user.onboarding_completed) === 0 &&
    (Number(user.student_tutorial_pending) === 1 ||
      Number(user.must_change_password) === 1)
  );
}
