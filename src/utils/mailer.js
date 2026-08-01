import nodemailer from "nodemailer";

function createSmtpTransporter() {
  return nodemailer.createTransport({
    host: process.env.OTP_SMTP_HOST,
    port: Number(process.env.OTP_SMTP_PORT),
    secure: false,
    auth: {
      user: process.env.OTP_SMTP_USERNAME,
      pass: process.env.OTP_SMTP_PASSWORD,
    },
  });
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
  const transporter = createSmtpTransporter();

  await transporter.sendMail({
    from: `"${process.env.OTP_SMTP_FROM_NAME}" <${process.env.OTP_SMTP_FROM_EMAIL}>`,
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
  const transporter = createSmtpTransporter();
  const nameHtml = escapeHtml(name || "there");
  const resetLinkHtml = escapeHtml(resetLink);

  await transporter.sendMail({
    from: `"${process.env.OTP_SMTP_FROM_NAME}" <${process.env.OTP_SMTP_FROM_EMAIL}>`,
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

export async function sendStudentTemporaryPasswordEmail(email, temporaryPassword) {
  const transporter = createSmtpTransporter();
  const passwordHtml = escapeHtml(temporaryPassword);

  await transporter.sendMail({
    from: `"${process.env.OTP_SMTP_FROM_NAME}" <${process.env.OTP_SMTP_FROM_EMAIL}>`,
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
