import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Moon, Sun, BookOpenCheck } from "lucide-react";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const { user, loading, signIn, signUp } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) navigate({ to: "/" });
  }, [user, loading, navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signin") {
        await signIn(email, password);
        toast.success("Welcome back.");
      } else {
        await signUp(email, password, name || email.split("@")[0]);
        toast.success("Account created. You're signed in.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      {/* Left: brand panel */}
      <div className="hidden lg:flex flex-col justify-between p-12 bg-primary text-primary-foreground relative overflow-hidden">
        <div className="absolute inset-0 paper-grain opacity-20" />
        <div className="relative">
          <div className="flex items-center gap-2 font-display text-xl">
            <BookOpenCheck className="h-6 w-6" />
            Khata
          </div>
        </div>
        <div className="relative space-y-6 max-w-md">
          <h1 className="font-display text-5xl leading-[1.05] tracking-tight">
            Read every script.<br />Grade with care.
          </h1>
          <p className="text-primary-foreground/75 text-base leading-relaxed">
            Upload handwritten exam papers in Bangla or English. Khata transcribes them
            into structured text and grades them against your rubric — so you can focus on
            teaching.
          </p>
        </div>
        <div className="relative text-xs text-primary-foreground/60">
          ✦ Built for teachers
        </div>
      </div>

      {/* Right: auth form */}
      <div className="flex items-center justify-center p-6 sm:p-12 relative">
        <button
          onClick={toggle}
          aria-label="Toggle theme"
          className="absolute top-4 right-4 inline-flex h-9 w-9 items-center justify-center rounded-full border border-border hover:bg-muted transition-colors"
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        <div className="w-full max-w-sm space-y-8">
          <div className="lg:hidden flex items-center gap-2 font-display text-xl text-foreground">
            <BookOpenCheck className="h-6 w-6 text-accent" />
            Khata
          </div>
          <div>
            <h2 className="font-display text-3xl text-foreground">
              {mode === "signin" ? "Welcome back" : "Create your account"}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {mode === "signin" ? "Sign in to continue evaluating." : "Start grading in under a minute."}
            </p>
          </div>

          <form onSubmit={submit} className="space-y-4">
            {mode === "signup" && (
              <div className="space-y-1.5">
                <Label htmlFor="name">Display name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ms. Rahman" />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@school.edu" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
            </Button>
          </form>

          <div className="text-sm text-muted-foreground text-center">
            {mode === "signin" ? (
              <>New here?{" "}
                <button onClick={() => setMode("signup")} className="text-foreground font-medium underline-offset-4 hover:underline">
                  Create an account
                </button>
              </>
            ) : (
              <>Already have an account?{" "}
                <button onClick={() => setMode("signin")} className="text-foreground font-medium underline-offset-4 hover:underline">
                  Sign in
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
