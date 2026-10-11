import nodemailer from "nodemailer";

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

  const missingKeys = [
    ["OTP_SMTP_HOST", config.host],
    ["OTP_SMTP_PORT", process.env.OTP_SMTP_PORT],
    ["OTP_SMTP_USERNAME", config.username],
    ["OTP_SMTP_PASSWORD", config.password],
    ["OTP_SMTP_FROM_EMAIL", config.fromEmail],
  ]
    .filter(([, value]) => !String(value || "").trim())
    .map(([key]) => key);

  if (!Number.isFinite(port) || port <= 0) {
    missingKeys.push("OTP_SMTP_PORT");
  }

  if (missingKeys.length > 0) {
    const error = new Error(
      `SMTP configuration is incomplete: ${missingKeys.join(", ")}`,
    );
    error.code = "SMTP_CONFIG_MISSING";
    throw error;
  }

  return config;
}

function createSmtpMailer() {
  const config = getSmtpConfig();

  return {
    transporter: nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: {
        user: config.username,
        pass: config.password,
      },
    }),
    from: `"${config.fromName}" <${config.fromEmail}>`,
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendOtpEmail(email, name, otp) {
  const { transporter, from } = createSmtpMailer();

  await transporter.sendMail({
    from,
    to: email,
    subject: "PuffyBrain Verification Code",
    html: `
      <h2>Verify Your Email</h2>
      <p>Hi ${name},</p>
      <p>Your PuffyBrain verification code is:</p>
      <h1 style="letter-spacing:4px;">${otp}</h1>
      <p>This code expires in 5 minutes.</p>
      <p>The PuffyBrain Team</p>
    `,
    text: `Your PuffyBrain verification code is ${otp}. It expires in 5 minutes.`,
  });
}

export async function sendPasswordResetEmail(email, name, resetLink) {
  const { transporter, from } = createSmtpMailer();
  const nameHtml = escapeHtml(name || "there");
  const resetLinkHtml = escapeHtml(resetLink);

  await transporter.sendMail({
    from,
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
) {
  const { transporter, from } = createSmtpMailer();
  const passwordHtml = escapeHtml(temporaryPassword);

  await transporter.sendMail({
    from,
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

This email was sent because a temporary password was generated for your account. If you did not expect this, please contact your administrator.`,
  });
}

export async function sendEnrollmentDeclinedEmail(
  email,
  studentName,
  courseName,
  courseCode,
  reason,
) {
  const { transporter, from } = createSmtpMailer();

  const nameHtml = escapeHtml(studentName || "Student");
  const courseNameHtml = escapeHtml(courseName || "your course");
  const courseCodeHtml = escapeHtml(courseCode || "");
  const reasonHtml = escapeHtml(reason);

  await transporter.sendMail({
    from,
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
  const { transporter, from } = createSmtpMailer();

  const professorNameHtml = escapeHtml(professorName || "Professor");
  const studentNameHtml = escapeHtml(studentName || "A student");
  const courseNameHtml = escapeHtml(courseName || "your course");

  await transporter.sendMail({
    from,
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
  const { transporter, from } = createSmtpMailer();

  const nameHtml = escapeHtml(studentName || "Student");

  const courseNameHtml = escapeHtml(courseName || "your course");

  const reasonHtml = escapeHtml(reason || "No reason provided.");

  const professorNameHtml = escapeHtml(professorName || "Professor");

  await transporter.sendMail({
    from,
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
