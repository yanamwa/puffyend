import test, { after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { db } from "../src/db.js";
import { login } from "../src/controllers/authController.js";
import {
  completeUserTutorial,
  createProfessorAccount,
  getCurrentUser,
} from "../src/controllers/userController.js";
import authenticateUser, {
  authenticateAccountSetup,
} from "../src/middleware/authMiddleware.js";

after(() => db.end());

const professor = {
  userId: 11,
  email: "new-professor@example.test",
  role: "professor",
  name: "New Professor",
  verification_status: "approved",
  is_verified: 1,
  onboarding_completed: 1,
  professor_tutorial_pending: 1,
};

function response() {
  return {
    statusCode: 200,
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

function requestFor(user) {
  const token = jwt.sign(
    { userId: user.userId, role: user.role },
    process.env.JWT_SECRET || "puffybrain-secret",
  );
  return { headers: { authorization: `Bearer ${token}` } };
}

async function setupRequest(user, handler) {
  const req = requestFor(user);
  const res = response();
  let authorized = false;
  await authenticateAccountSetup(req, res, () => {
    authorized = true;
  });
  if (authorized) await handler(req, res);
  return res;
}

test("the professor tutorial persists per account without blocking the dashboard", async (context) => {
  const user = { ...professor };
  context.mock.method(db, "execute", async (sql, args) => {
    assert.deepEqual(args, [user.userId]);
    if (sql.includes("SELECT")) {
      if (sql.includes("profile_image"))
        assert.match(sql, /professor_tutorial_pending/);
      return [[{ ...user }]];
    }
    if (sql.includes("SET last_active")) return [{ affectedRows: 1 }];
    assert.match(sql, /SET professor_tutorial_pending = 0/);
    assert.match(sql, /verification_status = 'approved'/);
    user.professor_tutorial_pending = 0;
    return [{ affectedRows: 1 }];
  });

  const current = await setupRequest(user, getCurrentUser);
  assert.equal(current.body.user.professorTutorialPending, true);
  let dashboardAllowed = false;
  await authenticateUser(requestFor(user), response(), () => {
    dashboardAllowed = true;
  });
  assert.equal(dashboardAllowed, true);

  for (let i = 0; i < 2; i++) {
    const completed = await setupRequest(user, completeUserTutorial);
    assert.deepEqual(completed.body, {
      success: true,
      user: { professorTutorialPending: false },
    });
  }
  const refreshed = await setupRequest(user, getCurrentUser);
  assert.equal(refreshed.body.user.professorTutorialPending, false);
  assert.equal(refreshed.body.user.onboardingCompleted, true);
});

test("approved professors can complete the tour before changing their password while regular APIs stay gated", async (context) => {
  const user = { ...professor, verification_status: "pending" };
  let completionWrites = 0;
  context.mock.method(db, "execute", async (sql) => {
    if (sql.includes("SELECT")) return [[user]];
    if (sql.includes("SET last_active")) return [{ affectedRows: 1 }];
    assert.match(sql, /SET professor_tutorial_pending = 0/);
    assert.doesNotMatch(sql, /must_change_password/);
    completionWrites++;
    user.professor_tutorial_pending = 0;
    return [{ affectedRows: 1 }];
  });

  const verifyPasswordGate = async () => {
    for (const method of ["GET", "POST"]) {
      const result = response();
      await authenticateUser({ ...requestFor(user), method }, result, () => {
        assert.fail("Regular API request bypassed password setup");
      });
      assert.equal(result.statusCode, 403);
      assert.equal(result.body.code, "PASSWORD_CHANGE_REQUIRED");
    }
  };

  const pendingApproval = await setupRequest(user, completeUserTutorial);
  assert.equal(pendingApproval.statusCode, 403);
  assert.equal(pendingApproval.body.code, "PROFESSOR_REGISTRATION_PENDING");
  assert.equal(completionWrites, 0);

  user.verification_status = "approved";
  user.must_change_password = 1;
  const current = await setupRequest(user, getCurrentUser);
  assert.equal(current.body.user.professorTutorialPending, true);
  assert.equal(current.body.user.mustChangePassword, true);
  await verifyPasswordGate();

  const completed = await setupRequest(user, completeUserTutorial);
  assert.deepEqual(completed.body, {
    success: true,
    user: { professorTutorialPending: false },
  });
  assert.equal(completionWrites, 1);
  const refreshed = await setupRequest(user, getCurrentUser);
  assert.equal(refreshed.body.user.professorTutorialPending, false);
  assert.equal(refreshed.body.user.mustChangePassword, true);
  await verifyPasswordGate();
});

test("login reports the saved professor tutorial state for new and existing accounts", async (context) => {
  const user = { ...professor, password: "test-password-hash" };
  context.mock.method(bcrypt, "compare", async () => true);
  context.mock.method(db, "execute", async (sql) => {
    if (sql.includes("FROM users")) return [[{ ...user }]];
    if (sql.includes("FROM system_settings")) return [[]];
    if (sql.includes("INSERT INTO audit_logs")) return [{ insertId: 1 }];
    assert.fail(`Unexpected database request: ${sql}`);
  });
  const req = {
    body: { email: user.email, password: "test-password" },
    headers: {},
  };
  const firstLogin = response();
  await login(req, firstLogin);
  assert.equal(firstLogin.body.user.professorTutorialPending, true);

  user.professor_tutorial_pending = 0;
  const existingLogin = response();
  await login(req, existingLogin);
  assert.equal(existingLogin.body.user.professorTutorialPending, false);
});

test("admin-provisioned professors start with a pending tutorial", async (context) => {
  context.mock.method(bcrypt, "hash", async () => "test-password-hash");
  let inserted = false;
  context.mock.method(db, "execute", async (sql) => {
    if (sql.includes("FROM system_settings")) return [[]];
    if (sql.includes("WHERE email = ?")) return [[]];
    if (sql.includes("INSERT INTO users")) {
      assert.match(
        sql,
        /onboarding_completed,\s*professor_tutorial_pending,\s*must_change_password/,
      );
      assert.match(sql, /'approved',\s*1,\s*1,\s*1,\s*\?/);
      inserted = true;
      return [{ insertId: professor.userId }];
    }
    if (sql.includes("FROM users")) return [[professor]];
    if (sql.includes("INSERT INTO audit_logs")) return [{ insertId: 1 }];
    assert.fail(`Unexpected database request: ${sql}`);
  });
  const result = response();
  await createProfessorAccount(
    {
      user: { userId: 1, role: "super_admin" },
      body: {
        email: professor.email,
        name: professor.name,
        department: "Education",
        employmentProof: "/uploads/professor-proofs/test.jpg",
      },
      headers: {},
    },
    result,
  );
  assert.equal(result.statusCode, 201);
  assert.equal(inserted, true);
});
