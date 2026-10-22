-- D-04：平台注册邀请（invite 模式下，只有收到邀请的邮箱能注册）。与工作区邀请（加入某个工作区）分开；
-- 同一邮箱同一时刻至多一条有效邀请；注册成功即标记 ACCEPTED。
CREATE TABLE "signup_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"invited_by" text,
	"note" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_invitations_status_ck" CHECK ("signup_invitations"."status" in ('PENDING','ACCEPTED','REVOKED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "signup_invitations_pending_email_uq" ON "signup_invitations" USING btree ("email") WHERE "signup_invitations"."status" = 'PENDING';
