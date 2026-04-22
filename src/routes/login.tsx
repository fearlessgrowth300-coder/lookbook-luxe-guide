import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { ease, dur, tap } from "@/lib/motion";

export const Route = createFileRoute("/login")({
  component: LoginPage,
  head: () => ({
    meta: [{ title: "Sign in — Atelier" }],
  }),
});

const Schema = z.object({
  email: z.string().email("That doesn't look like an email."),
  password: z.string().min(6, "At least 6 characters."),
});
type Form = z.infer<typeof Schema>;

function LoginPage() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<"signin" | "signup">("signin");

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Form>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(Schema as any),
  });

  useEffect(() => {
    if (!loading && user) navigate({ to: "/today", replace: true });
  }, [user, loading, navigate]);

  const onSubmit = async (data: Form) => {
    setServerError(null);
    setSubmitting(true);
    try {
      const fn =
        mode === "signin"
          ? supabase.auth.signInWithPassword(data)
          : supabase.auth.signUp({
              ...data,
              options: { emailRedirectTo: `${window.location.origin}/today` },
            });
      const { error } = await fn;
      if (error) {
        setServerError(error.message);
        setSubmitting(false);
        return;
      }
      // Auth listener handles redirect.
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Something went wrong.");
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-bone lg:flex-row">
      {/* Hero image with Ken Burns */}
      <div className="relative h-[40vh] overflow-hidden lg:h-screen lg:w-[55%]">
        <motion.div
          className="absolute inset-0 bg-cover bg-center"
          style={{
            backgroundImage:
              "url(https://images.unsplash.com/photo-1558769132-cb1aea458c5e?auto=format&fit=crop&w=1600&q=80)",
          }}
          animate={{ scale: [1, 1.05, 1] }}
          transition={{
            duration: 18,
            ease: ease.drift,
            repeat: Infinity,
          }}
        />
        <div className="absolute inset-0 bg-graphite/10" />
        <div className="absolute bottom-8 left-8 lg:bottom-16 lg:left-16">
          <p className="font-display text-[20px] font-normal text-bone">Atelier</p>
        </div>
      </div>

      {/* Form */}
      <div className="flex flex-1 items-center justify-center px-6 py-12 lg:px-16">
        <div className="w-full max-w-[360px]">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: dur.hero, ease: ease.luxury }}
          >
            <h1 className="font-display text-[40px] font-normal leading-[1.05] text-graphite">
              {mode === "signin" ? "Sign in" : "Begin"}
            </h1>
            <p className="mt-3 text-[14px] text-ink">Your wardrobe, styled daily.</p>
          </motion.div>

          <form onSubmit={handleSubmit(onSubmit)} className="mt-12 space-y-8">
            <div>
              <input
                {...register("email")}
                type="email"
                autoComplete="email"
                placeholder="name@domain.com"
                className="w-full border-0 border-b border-ink bg-transparent pb-3 text-[15px] text-graphite placeholder:text-ink/50 focus:border-graphite focus:outline-none focus:ring-0"
                style={{ transition: "border-color 220ms cubic-bezier(0.4,0,0.2,1)" }}
                aria-label="Email"
              />
              <AnimatePresence>
                {errors.email && (
                  <motion.p
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: dur.hover, ease: ease.tactile }}
                    className="mt-2 text-[13px] text-signal"
                  >
                    {errors.email.message}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>

            <div>
              <input
                {...register("password")}
                type="password"
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                placeholder="password"
                className="w-full border-0 border-b border-ink bg-transparent pb-3 text-[15px] text-graphite placeholder:text-ink/50 focus:border-graphite focus:outline-none focus:ring-0"
                style={{ transition: "border-color 220ms cubic-bezier(0.4,0,0.2,1)" }}
                aria-label="Password"
              />
              <AnimatePresence>
                {errors.password && (
                  <motion.p
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: dur.hover, ease: ease.tactile }}
                    className="mt-2 text-[13px] text-signal"
                  >
                    {errors.password.message}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>

            <AnimatePresence>
              {serverError && (
                <motion.p
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: dur.hover, ease: ease.tactile }}
                  className="text-[13px] text-signal"
                >
                  {serverError}
                </motion.p>
              )}
            </AnimatePresence>

            <motion.button
              {...tap}
              type="submit"
              disabled={submitting}
              className="flex h-12 w-full items-center justify-center bg-graphite font-mono text-[12px] uppercase tracking-[0.08em] text-bone transition-colors hover:bg-noir disabled:opacity-60"
            >
              {submitting ? <DriftDots /> : "Continue"}
            </motion.button>

            <div className="flex items-center justify-between">
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink">
                Email + password
              </p>
              <button
                type="button"
                onClick={() => setMode((m) => (m === "signin" ? "signup" : "signin"))}
                className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink transition-colors hover:text-graphite"
              >
                {mode === "signin" ? "Create account" : "Have an account?"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

function DriftDots() {
  return (
    <span className="flex items-center gap-1.5" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-bone"
          animate={{ opacity: [0, 1, 0] }}
          transition={{
            duration: 0.6,
            repeat: Infinity,
            ease: ease.tactile,
            delay: i * 0.12,
          }}
        />
      ))}
    </span>
  );
}
