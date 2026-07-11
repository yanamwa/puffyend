import nodemailer from "nodemailer";

export async function sendOtpEmail(email, name, otp) {
  const transporter = nodemailer.createTransport({
    host: process.env.OTP_SMTP_HOST,
    port: Number(process.env.OTP_SMTP_PORT),
    secure: false,
    auth: {
      user: process.env.OTP_SMTP_USERNAME,
      pass: process.env.OTP_SMTP_PASSWORD,
    },
  });

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