export function isApprovedProfessor(user) {
  return (
    user?.role === "professor" &&
    user.verification_status === "approved" &&
    Number(user.is_verified) === 1
  );
}

export function hasProfessorAdminAccess(user) {
  return isApprovedProfessor(user) && Number(user.professor_admin_access) === 1;
}
