import nodemailer from "nodemailer";
import "../environment.js";
import { renderQuizResultEmail } from "./quizResultEmail.js";

function getSmtpConfig() {
  const port = Number(process.env.OTP_SMTP_PORT);
  const config = {
    host: process.env.OTP_SMTP_HOST,
    port,
    username: process.env.OTP_SMTP_USERNAME,
    password: process.env.OTP_SMTP_PASSWORD,
    fromEmail: process.env.OTP_SMTP_FROM_EMAIL,
    fromName: process.env.OTP_SMTP_FROM_NAME || "PuffyBrain",
  };

  const missingKeys = new Set([
    ["OTP_SMTP_HOST", config.host],
    ["OTP_SMTP_PORT", process.env.OTP_SMTP_PORT],
    ["OTP_SMTP_USERNAME", config.username],
    ["OTP_SMTP_PASSWORD", config.password],
    ["OTP_SMTP_FROM_EMAIL", config.fromEmail],
  ]
    .filter(([, value]) => !String(value || "").trim())
    .map(([key]) => key));

  if (!Number.isFinite(port) || port <= 0) {
    missingKeys.add("OTP_SMTP_PORT");
  }

  if (missingKeys.size > 0) {
    const error = new Error(
      `SMTP configuration is incomplete: ${[...missingKeys].join(", ")}`,
    );
    error.code = "SMTP_CONFIG_MISSING";
    throw error;
  }

  return config;
}

async function sendEmail(message) {
  const config = getSmtpConfig();
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: {
      user: config.username,
      pass: config.password,
    },
  });
  const from = `"${config.fromName}" <${config.fromEmail}>`;
  const info = await transporter.sendMail({ from, ...message });
  if (!info.accepted?.length) {
    throw new Error("The mail server did not accept the recipient.");
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendProfessorAdminAccessEmail({ email, name }) {
  await sendEmail({
    to: email,
    subject: "PuffyBrain admin access granted",
    text: [
      `Hi ${name},`,
      "You’ve been granted administrator access in PuffyBrain.",
      "Sign in with your existing professor credentials. Open your profile menu and choose Switch to Admin to go to the Admin Dashboard.",
      "Use Switch to Professor to return to your professor dashboard.",
    ].join("\n\n"),
  });
}

export async function sendQuizResultEmail(email, subject, report, result) {
  await sendEmail({
    to: email,
    subject,
    text: report,
    html: renderQuizResultEmail(result),
  });
}

export async function sendOtpEmail(email, name, otp) {
  await sendEmail({
    to: email,
    subject: "PuffyBrain Verification Code",
    html: `
      <h2>Verify Your Email</h2>
      <p>Hi ${escapeHtml(name)},</p>
      <p>Your PuffyBrain verification code is:</p>
      <h1 style="letter-spacing:4px;">${escapeHtml(otp)}</h1>
      <p>This code expires in 5 minutes.</p>
      <p>The PuffyBrain Team</p>
    `,
    text: `Your PuffyBrain verification code is ${otp}. It expires in 5 minutes.`,
  });
}

export async function sendProfessorRegistrationDecisionEmail({ email, name, status, reason }) {
  const approved = status === "approved";
  const heading = approved ? "Professor Account Approved" : "Professor Registration Declined";
  const message = approved
    ? "Your professor account has been approved by an administrator. You can sign in using your registered email and password once your email is verified."
    : "Your professor registration has been declined by an administrator. Your registration will be deleted after 24 hours, and you can register again using the same email address.";
  await sendEmail({
    to: email,
    subject: `PuffyBrain — ${heading}`,
    text: `Hi ${name || "Professor"},\n\n${message}${approved ? "" : `\n\nReason for decline:\n${reason}`}\n\nPuffyBrain Team`,
    html: `<div style="font-family:Arial,sans-serif;color:#263e5b;max-width:600px;margin:auto;border:1px solid #cbdced;border-radius:12px;overflow:hidden;">
      <h2 style="margin:0;padding:22px;background:#7fa9d6;color:#fff;">${heading}</h2>
      <div style="padding:24px;line-height:1.6;">
        <p>Hi ${escapeHtml(name || "Professor")},</p>
        <p>${message}</p>
        ${approved ? "" : `<div style="padding:16px;background:#edf5fd;border-left:4px solid #7fa9d6;"><strong>Reason for decline</strong><p style="white-space:pre-wrap;overflow-wrap:anywhere;">${escapeHtml(reason)}</p></div>`}
        <p>PuffyBrain Team</p>
      </div>
    </div>`,
  });
}

export async function sendPasswordResetEmail(email, name, resetLink) {
  const nameHtml = escapeHtml(name || "there");
  const resetLinkHtml = escapeHtml(resetLink);

  await sendEmail({
    to: email,
    subject: "Reset your PuffyBrain password",
    html: `
      <div style="margin:0;padding:32px 16px;background:#f6f7fb;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
        <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e4e7ec;border-radius:8px;padding:24px;box-sizing:border-box;">
          <div style="font-size:18px;font-weight:800;color:#111827;line-height:1.2;">
            PuffyBrain
          </div>
          <div style="height:1px;background:#e5e7eb;margin:22px 0 18px;"></div>
          <h1 style="margin:0 0 18px;color:#111827;font-size:20px;line-height:1.3;font-weight:800;">
            Reset your password
          </h1>
          <p style="margin:0 0 18px;color:#111827;font-size:14px;line-height:1.6;">
            Hi ${nameHtml}, use the button below to create a new password for your PuffyBrain account.
          </p>
          <div style="text-align:center;margin:26px 0;">
            <a href="${resetLinkHtml}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:6px;padding:14px 28px;font-size:15px;font-weight:800;line-height:1.2;">
              Reset Password
            </a>
          </div>
          <p style="margin:0 0 18px;color:#4b5563;font-size:13px;line-height:1.6;">
            This link expires in 1 hour. If you did not request a password reset, you can ignore this email.
          </p>
          <p style="margin:0;color:#6b7280;font-size:12px;line-height:1.6;word-break:break-all;">
            ${resetLinkHtml}
          </p>
        </div>
      </div>
    `,
    text: `PuffyBrain

Hi ${name || "there"},

Use this link to reset your password. It expires in 1 hour:

${resetLink}

If you did not request a password reset, you can ignore this email.`,
  });
}

export async function sendStudentTemporaryPasswordEmail(
  email,
  temporaryPassword,
  otp,
) {
  const passwordHtml = escapeHtml(temporaryPassword);
  const otpHtml = escapeHtml(otp);

  await sendEmail({
    to: email,
    subject: "Your Puffybrain temporary password",
    html: `
      <div style="margin:0;padding:32px 16px;background:#f6f7fb;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
        <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e4e7ec;border-radius:8px;padding:24px 24px 20px;box-sizing:border-box;">
          <div style="font-size:18px;font-weight:800;color:#111827;line-height:1.2;">
            Puffybrain
          </div>
          <div style="height:1px;background:#e5e7eb;margin:22px 0 18px;"></div>
          <h1 style="margin:0 0 18px;color:#111827;font-size:20px;line-height:1.3;font-weight:800;">
            Temporary Password
          </h1>
          <p style="margin:0;color:#111827;font-size:14px;line-height:1.6;">
            Here's your temporary password for your Puffybrain account. Make sure to change your password as soon as possible to avoid security problems.
          </p>
          <div style="text-align:center;margin:26px 0;">
            <div style="display:inline-block;background:#4f46e5;color:#ffffff;border-radius:6px;padding:14px 28px;font-size:18px;font-weight:800;letter-spacing:1px;line-height:1.2;">
              ${passwordHtml}
            </div>
          </div>
          <h2 style="margin:0 0 10px;color:#111827;font-size:16px;line-height:1.4;font-weight:700;">
            Email Verification Code
          </h2>
          <p style="margin:0;color:#111827;font-size:14px;line-height:1.6;">
            Enter this 4-digit code the first time you sign in. It expires in 5 minutes.
          </p>
          <div style="text-align:center;margin:18px 0 26px;">
            <div style="display:inline-block;background:#eef4ff;color:#1f2937;border:1px solid #d5e2f5;border-radius:6px;padding:12px 24px;font-size:20px;font-weight:800;letter-spacing:5px;line-height:1.2;">
              ${otpHtml}
            </div>
          </div>
          <div style="height:1px;background:#e5e7eb;margin:22px 0 18px;"></div>
          <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;">
            This email was sent because a temporary password was generated for your account. If you did not expect this, please contact your administrator.
          </p>
        </div>
      </div>
    `,
    text: `Puffybrain

Temporary Password

Here's your temporary password for your Puffybrain account. Make sure to change your password as soon as possible to avoid security problems.

${temporaryPassword}

Email Verification Code

Use this 4-digit code the first time you sign in. It expires in 5 minutes.

${otp}

This email was sent because a temporary password was generated for your account. If you did not expect this, please contact your administrator.`,
  });
}

export async function sendEnrollmentAcceptedEmail(email, studentName, courseName) {
  await sendEmail({
    to: email,
    subject: `PuffyBrain Enrollment Approved - ${courseName}`,
    text: `Hi ${studentName},\n\nYour enrollment in ${courseName} has been approved. The course is now available in Enrolled Courses.\n\nPuffyBrain`,
  });
}

export async function sendEnrollmentDeclinedEmail(
  email,
  studentName,
  courseName,
  courseCode,
  reason,
) {
  const nameHtml = escapeHtml(studentName || "Student");
  const courseNameHtml = escapeHtml(courseName || "your course");
  const courseCodeHtml = escapeHtml(courseCode || "");
  const reasonHtml = escapeHtml(reason);

  await sendEmail({
    to: email,
    subject: `Enrollment Request Declined - ${courseName}`,

    html: `
      <div style="margin:0;padding:32px 16px;background:#f6f7fb;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
        <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e4e7ec;border-radius:8px;padding:24px;box-sizing:border-box;">

          <div style="font-size:18px;font-weight:800;color:#111827;line-height:1.2;">
            PuffyBrain
          </div>

          <div style="height:1px;background:#e5e7eb;margin:22px 0 18px;"></div>

          <h1 style="margin:0 0 18px;color:#111827;font-size:20px;line-height:1.3;font-weight:800;">
            Enrollment Request Declined
          </h1>

          <p style="margin:0 0 18px;color:#111827;font-size:14px;line-height:1.6;">
            Hi ${nameHtml},
          </p>

          <p style="margin:0 0 18px;color:#111827;font-size:14px;line-height:1.6;">
            Your enrollment request for
            <strong>${courseNameHtml}</strong>
            has been declined by the professor.
          </p>

          ${
            courseCodeHtml
              ? `
                <p style="margin:0 0 18px;color:#4b5563;font-size:14px;line-height:1.6;">
                  <strong>Course Code:</strong> ${courseCodeHtml}
                </p>
              `
              : ""
          }

          <div style="margin:22px 0;padding:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;">
            <div style="margin-bottom:8px;font-size:13px;font-weight:800;color:#374151;">
              Reason for declining:
            </div>

            <div style="font-size:14px;line-height:1.6;color:#111827;white-space:pre-wrap;">
              ${reasonHtml}
            </div>
          </div>

          <div style="height:1px;background:#e5e7eb;margin:22px 0 18px;"></div>

          <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;">
            This email was sent because your enrollment request in PuffyBrain was reviewed by the professor.
          </p>

        </div>
      </div>
    `,

    text: `PuffyBrain

Enrollment Request Declined

Hi ${studentName || "Student"},

Your enrollment request for ${courseName || "your course"} has been declined by the professor.

${courseCode ? `Course Code: ${courseCode}\n` : ""}
Reason for declining:
${reason}

PuffyBrain`,
  });
}

export async function sendEnrollmentRequestEmail(
  professorEmail,
  professorName,
  studentName,
  courseName,
) {
  const professorNameHtml = escapeHtml(professorName || "Professor");
  const studentNameHtml = escapeHtml(studentName || "A student");
  const courseNameHtml = escapeHtml(courseName || "your course");

  await sendEmail({
    to: professorEmail,
    subject: `New Enrollment Request - ${courseName}`,

    html: `
      <div style="
        margin:0;
        padding:32px 16px;
        background:#f6f7fb;
        font-family:Arial,Helvetica,sans-serif;
        color:#1f2937;
      ">
        <div style="
          max-width:560px;
          margin:0 auto;
          background:#ffffff;
          border:1px solid #e4e7ec;
          border-radius:8px;
          padding:24px;
          box-sizing:border-box;
        ">

          <div style="
            font-size:18px;
            font-weight:800;
            color:#111827;
          ">
            PuffyBrain
          </div>

          <div style="
            height:1px;
            background:#e5e7eb;
            margin:22px 0 18px;
          "></div>

          <h1 style="
            margin:0 0 18px;
            color:#111827;
            font-size:20px;
            font-weight:800;
          ">
            New Enrollment Request
          </h1>

          <p style="
            margin:0 0 16px;
            color:#111827;
            font-size:14px;
            line-height:1.6;
          ">
            Hi ${professorNameHtml},
          </p>

          <p style="
            margin:0 0 16px;
            color:#111827;
            font-size:14px;
            line-height:1.6;
          ">
            <strong>${studentNameHtml}</strong> is requesting to enroll
            in your course:
          </p>

          <div style="
            margin:20px 0;
            padding:16px;
            background:#f9fafb;
            border:1px solid #e5e7eb;
            border-radius:6px;
          ">
            <strong>${courseNameHtml}</strong>
          </div>

          <p style="
            margin:0;
            color:#4b5563;
            font-size:13px;
            line-height:1.6;
          ">
            Please log in to your PuffyBrain professor account to review
            the enrollment request. You may approve or decline the request
            from your course enrollment management page.
          </p>

          <div style="
            height:1px;
            background:#e5e7eb;
            margin:22px 0 18px;
          "></div>

          <p style="
            margin:0;
            color:#6b7280;
            font-size:12px;
          ">
            PuffyBrain Enrollment Notification
          </p>

        </div>
      </div>
    `,

    text: `PuffyBrain

New Enrollment Request

Hi ${professorName || "Professor"},

${studentName || "A student"} is requesting to enroll in:

${courseName || "your course"}

Please log in to your PuffyBrain professor account to review the enrollment request.

PuffyBrain`,
  });
}
export async function sendStudentUnenrolledEmail(
  email,
  studentName,
  courseName,
  reason,
  professorName,
) {
  const nameHtml = escapeHtml(studentName || "Student");

  const courseNameHtml = escapeHtml(courseName || "your course");

  const reasonHtml = escapeHtml(reason || "No reason provided.");

  const professorNameHtml = escapeHtml(professorName || "Professor");

  await sendEmail({
    to: email,

    subject: `Course Unenrollment - ${courseName}`,

    html: `
      <div
        style="
          margin:0;
          padding:32px 16px;
          background:#f6f7fb;
          font-family:Arial,Helvetica,sans-serif;
          color:#1f2937;
        "
      >
        <div
          style="
            max-width:560px;
            margin:0 auto;
            background:#ffffff;
            border:1px solid #e4e7ec;
            border-radius:8px;
            padding:24px;
            box-sizing:border-box;
          "
        >

          <div
            style="
              font-size:18px;
              font-weight:800;
              color:#111827;
              line-height:1.2;
            "
          >
            PuffyBrain
          </div>

          <div
            style="
              height:1px;
              background:#e5e7eb;
              margin:22px 0 18px;
            "
          ></div>

          <h1
            style="
              margin:0 0 18px;
              color:#111827;
              font-size:20px;
              line-height:1.3;
              font-weight:800;
            "
          >
            Course Unenrollment Notice
          </h1>

          <p
            style="
              margin:0 0 18px;
              color:#111827;
              font-size:14px;
              line-height:1.6;
            "
          >
            Hi ${nameHtml},
          </p>

          <p
            style="
              margin:0 0 18px;
              color:#111827;
              font-size:14px;
              line-height:1.6;
            "
          >
            You have been unenrolled from
            <strong>${courseNameHtml}</strong>
            by your professor.
          </p>

          <div
            style="
              margin:22px 0;
              padding:16px;
              background:#f9fafb;
              border:1px solid #e5e7eb;
              border-radius:6px;
            "
          >
            <div
              style="
                margin-bottom:8px;
                font-size:13px;
                font-weight:800;
                color:#374151;
              "
            >
              Reason for unenrollment:
            </div>

            <div
              style="
                font-size:14px;
                line-height:1.6;
                color:#111827;
                white-space:pre-wrap;
              "
            >
              ${reasonHtml}
            </div>
          </div>

          <p
            style="
              margin:0 0 18px;
              color:#4b5563;
              font-size:13px;
              line-height:1.6;
            "
          >
            If you have questions regarding this
            action, please contact
            ${professorNameHtml}.
          </p>

          <div
            style="
              height:1px;
              background:#e5e7eb;
              margin:22px 0 18px;
            "
          ></div>

          <p
            style="
              margin:0;
              color:#6b7280;
              font-size:12px;
              line-height:1.6;
            "
          >
            This email was sent because your
            enrollment status in PuffyBrain was
            updated by your professor.
          </p>

        </div>
      </div>
    `,

    text: `PuffyBrain

Course Unenrollment Notice

Hi ${studentName || "Student"},

You have been unenrolled from ${courseName || "your course"} by your professor.

Reason for unenrollment:
${reason || "No reason provided."}

If you have questions regarding this action, please contact ${
      professorName || "your professor"
    }.

PuffyBrain`,
  });
}
