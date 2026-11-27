"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import Image from "next/image";
import { createClient } from "@/lib/supabase/browser";
import {
  ArrowUpRight, Check, ChevronDown, CircleAlert, Film, Image as ImageIcon,
  LoaderCircle, LogOut, Plus, Sparkles, WandSparkles, Zap
} from "lucide-react";

type AdminUser = { id: string; email: string; display_name: string | null; credits: number; role: string };\n\ntype Job = {
  id: string;
  kind: "image" | "video";
  prompt: string;
  aspect_ratio: string;
  status: "queued" | "processing" | "succeeded" | "failed" | "storage_failed";
  provider_status?: string | null;
  error_message?: string | null;
  assetUrl?: string | null;
  asset_path?: string | null;
  created_at: string;
};

const ratios = ["1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4"];

export default function Studio() {
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [linkSent, setLinkSent] = useState(false);
  const [authError, setAuthError] = useState("");
  const [kind, setKind] = useState<"image" | "video">("image");
  const [prompt, setPrompt] = useState("");
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [ratio, setRatio] = useState("1:1");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [credits, setCredits] = useState<number | null>(null);
  const [role, setRole] = useState<"customer" | "admin">("customer");
  const [billingMessage, setBillingMessage] = useState("");
  const [adminUserId, setAdminUserId] = useState("");\n  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminAmount, setAdminAmount] = useState("50");
  const [adminReason, setAdminReason] = useState("");

  const supabase = useMemo(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null;
    try { return createClient(); } catch { return null; }
  }, []);
  const configurationError = supabase ? "" : "Supabase is not configured. Ask the administrator to finish the service setup.";

  const refreshAccount = useCallback(async () => {
    if (!supabase) return;
    const { data: { user: currentUser } } = await supabase.auth.getUser();
    setUser(currentUser);
    if (!currentUser) return;
    const { data } = await supabase.from("profiles").select("credits,role").eq("id", currentUser.id).single();
    if (data) {\n      setCredits(data.credits);\n      const isAdmin = data.role === "admin";\n      setRole(isAdmin ? "admin" : "customer");\n      if (isAdmin) {\n        const adminResponse = await fetch("/api/admin/credits", { cache: "no-store" });\n        if (adminResponse.ok) { const adminPayload = await adminResponse.json(); setAdminUsers(adminPayload.users || []); }\n      } else setAdminUsers([]);\n    }
    const response = await fetch("/api/generations?limit=12", { cache: "no-store" });
    if (response.ok) {
      const payload = await response.json();
      setJobs(payload.generations || []);
    }
  }, [supabase]);

  useEffect(() => {
    if (!supabase) return;
    void refreshAccount();
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      void refreshAccount();
    });
    return () => subscription.unsubscribe();
  }, [supabase, refreshAccount]);

  useEffect(() => {
    if (!activeJob || !["queued", "processing", "storage_failed"].includes(activeJob.status)) return;
    const jobId = activeJob.id;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/generations/${jobId}`, { cache: "no-store" });
      const payload = await response.json();
      if (response.ok) {
        setActiveJob(payload);
        if (!["queued", "processing", "storage_failed"].includes(payload.status)) {
          window.clearInterval(timer);
          await refreshAccount();
        }
      }
    }, 3500);
    return () => window.clearInterval(timer);
  }, [activeJob?.id, activeJob?.status, refreshAccount]);

  async function sendMagicLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setAuthError("");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` }
    });
    if (error) setAuthError(error.message);
    else setLinkSent(true);
  }

  async function buyCredits(packageId: "starter" | "creator" | "studio") {
    setBillingMessage("");
    try {
      const response = await fetch("/api/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packageId }) });
      const payload = await response.json();
      if (!response.ok || !payload.url) throw new Error(payload.error || "Could not start checkout.");
      window.location.assign(payload.url);
    } catch (error) { setBillingMessage(error instanceof Error ? error.message : "Checkout could not start."); }
  }

  async function adjustCredits(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBillingMessage("");
    try {
      const response = await fetch("/api/admin/credits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: adminUserId.trim(), amount: Number(adminAmount), reason: adminReason }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Credit adjustment failed.");
      setBillingMessage("Credit adjustment applied.");
      setAdminUserId(""); setAdminReason("");
      await refreshAccount();
    } catch (error) { setBillingMessage(error instanceof Error ? error.message : "Credit adjustment failed."); }
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setUser(null);
    setCredits(null);
    setJobs([]);
    setActiveJob(null);
  }

  async function generate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setBusy(true);
    setActiveJob(null);
    try {
      let referenceAssetPath: string | undefined;
      if (referenceFile) {
        const upload = new FormData();
        upload.append("file", referenceFile);
        const uploadResponse = await fetch("/api/uploads", { method: "POST", body: upload });
        const uploadPayload = await uploadResponse.json();
        if (!uploadResponse.ok) throw new Error(uploadPayload.error || "Reference image upload failed.");
        referenceAssetPath = uploadPayload.path;
      }
      const response = await fetch("/api/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, prompt, aspectRatio: ratio, referenceAssetPath })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Generation request failed.");
      setActiveJob({
        id: payload.id, kind, prompt, aspect_ratio: ratio, status: payload.status,
        created_at: new Date().toISOString()
      });
      setPrompt("");
      setReferenceFile(null);
      setMessage("Your request was accepted by the configured provider.");
      await refreshAccount();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start generation.");
    } finally {
      setBusy(false);
    }
  }

  const visibleJobs = activeJob ? [activeJob, ...jobs.filter((job) => job.id !== activeJob.id)] : jobs;

  if (configurationError) {
    return <main className="config-screen"><div className="config-card"><div className="brand-mark"><Sparkles size={20}/></div><p className="eyebrow">LUMI AI / SERVICE SETUP</p><h1>Workspace setup required</h1><p>{configurationError}</p><p className="muted">This application does not contain demo data. The workspace will become available when its Supabase project is configured.</p></div></main>;
  }

  if (!user) {
    return <main className="auth-screen">
      <div className="auth-glow"/>
      <div className="auth-card">
        <div className="brand-lockup"><span className="brand-mark"><Sparkles size={20}/></span><span>LUMI<span className="brand-ai"> AI</span></span></div>
        <p className="eyebrow">YOUR CREATIVE INTELLIGENCE STUDIO</p>
        <h1>Make the unreal,<br/><span>real.</span></h1>
        <p className="auth-copy">Create extraordinary images and cinematic video with real generative models, all in one focused workspace.</p>
        <form onSubmit={sendMagicLink} className="auth-form">
          <label htmlFor="email">Email address</label>
          <input id="email" type="email" required autoComplete="email" placeholder="you@company.com" value={email} onChange={(event) => setEmail(event.target.value)}/>
          <button className="primary-button" type="submit">Continue with email <ArrowUpRight size={16}/></button>
        </form>
        {linkSent && <p className="success-note"><Check size={15}/> Sign-in link sent. Check your inbox to continue.</p>}
        {authError && <p className="error-note"><CircleAlert size={15}/>{authError}</p>}
        <p className="auth-footnote">Secure, passwordless sign-in powered by your LUMI account.</p>
      </div>
      <footer className="auth-footer">LUMI AI <span>·</span> CREATE WITHOUT LIMITS</footer>
    </main>;
  }

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand-lockup"><span className="brand-mark"><Sparkles size={18}/></span><span>LUMI<span className="brand-ai"> AI</span></span></div>
      <div className="workspace-switch"><span className="workspace-avatar">L</span><span><b>Personal workspace</b><small>Creator plan</small></span><ChevronDown size={15}/></div>
      <p className="side-label">WORKSPACE</p>
      <a className="side-link active" href="#create"><WandSparkles size={17}/> Create</a>
      <a className="side-link" href="#library"><ImageIcon size={17}/> My generations</a>
      <div className="sidebar-bottom">
        <div className="credit-card"><div className="credit-top"><span>Available credits</span><Zap size={15}/></div><strong>{credits === null ? "—" : credits.toLocaleString()}</strong><small>Credits are managed securely on your account.</small></div>
        <div className="user-row"><div className="user-avatar">{(user.email || "U").slice(0,1).toUpperCase()}</div><div className="user-details"><b>{user.email}</b><small>Signed in</small></div><button className="icon-button" onClick={signOut} aria-label="Sign out"><LogOut size={16}/></button></div>
      </div>
    </aside>

    <section className="main-panel">
      <header className="topbar"><div className="breadcrumb">Studio <span>/</span> Create</div><div className="top-actions"><span className="secure-pill"><span/> Secure workspace</span><button className="avatar-button">{(user.email || "U").slice(0,1).toUpperCase()}</button></div></header>
      <div className="content-wrap">
        <section className="hero-copy"><div className="eyebrow"><span className="eyebrow-line"/> THE CREATIVE ENGINE</div><h1>Imagine it.<br/><span>Bring it to life.</span></h1><p>Turn a thought into a visual experience. Start with an image or build a moving world with video.</p></section>

        <section className="creator-card billing-card" id="credits"><div className="creator-heading"><div><span className="section-kicker">ACCOUNT / CREDITS</span><h2>Get more creative credits</h2></div><span className="job-id">{credits === null ? "—" : credits.toLocaleString()} AVAILABLE</span></div><div className="credit-packages"><button type="button" onClick={() => void buyCredits("starter")}><b>Starter</b><strong>$4.99</strong><span>100 credits</span></button><button type="button" onClick={() => void buyCredits("creator")}><b>Creator</b><strong>$19.99</strong><span>550 credits</span></button><button type="button" onClick={() => void buyCredits("studio")}><b>Studio</b><strong>$49.99</strong><span>1,600 credits</span></button></div>{billingMessage && <p className="inline-message">{billingMessage}</p>}<p className="muted">Secure one-time checkout. Credits are added after Stripe confirms successful payment.</p></section>

        {role === "admin" && <section className="creator-card admin-card"><div className="creator-heading"><div><span className="section-kicker">ADMINISTRATION</span><h2>Manage user credits</h2></div><span className="live-indicator">ADMIN ONLY</span></div><form onSubmit={adjustCredits} className="admin-credit-form"><label>Account<select value={adminUserId} onChange={(event) => setAdminUserId(event.target.value)} required><option value="">Choose a user account</option>{adminUsers.map((item) => <option key={item.id} value={item.id}>{item.email || item.id} · {item.credits} credits</option>)}</select></label><label>Credit change<input type="number" value={adminAmount} onChange={(event) => setAdminAmount(event.target.value)} required min={-100000} max={100000}/></label><label>Reason<input value={adminReason} onChange={(event) => setAdminReason(event.target.value)} required minLength={5} maxLength={500} placeholder="Support adjustment or promotion"/></label><button className="primary-button" type="submit">Apply adjustment <ArrowUpRight size={16}/></button></form></section>}

        <section className="creator-card" id="create">
          <div className="creator-heading"><div><span className="section-kicker">01 / GENERATION</span><h2>What are we creating?</h2></div><div className="live-indicator"><span/> REAL MODEL EXECUTION</div></div>
          <div className="mode-switch">
            <button className={kind === "image" ? "mode-option selected" : "mode-option"} onClick={() => setKind("image")} type="button"><ImageIcon size={17}/> Image <small>Still imagery</small></button>
            <button className={kind === "video" ? "mode-option selected" : "mode-option"} onClick={() => setKind("video")} type="button"><Film size={17}/> Video <small>Motion &amp; story</small></button>
          </div>
          <form onSubmit={generate}>
            <label className="field-label" htmlFor="prompt">Describe your vision</label>
            <div className="reference-upload"><label htmlFor="reference-image">Reference image <span>Optional · JPEG, PNG or WebP · up to 20 MB</span></label><input id="reference-image" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setReferenceFile(event.target.files?.[0] || null)}/>{referenceFile && <button type="button" className="remove-reference" onClick={() => setReferenceFile(null)}>Remove {referenceFile.name}</button>}</div>
            <textarea id="prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} minLength={3} maxLength={3000} required placeholder={kind === "image" ? "A cinematic editorial portrait, soft directional light, rich natural textures, shot on medium format..." : "A slow cinematic tracking shot through a futuristic glass city at blue hour, atmospheric reflections..."}/>
            <div className="prompt-meta"><span>Be specific about lighting, composition, camera and mood.</span><span>{prompt.length}/3000</span></div>
            <div className="control-row">
              <div className="ratio-control"><label htmlFor="ratio">Aspect ratio</label><select id="ratio" value={ratio} onChange={(event) => setRatio(event.target.value)}>{ratios.map((value) => <option key={value}>{value}</option>)}</select></div>
              <div className="quality-note"><Sparkles size={15}/><span>Output quality depends on the selected model and its supported settings.</span></div>
              <button className="primary-button generate-button" type="submit" disabled={busy || prompt.trim().length < 3}>{busy ? <><LoaderCircle className="spin" size={17}/> Connecting…</> : <>Generate <ArrowUpRight size={17}/></>}</button>
            </div>
          </form>
          {message && <div className={message.includes("accepted") ? "inline-message" : "inline-message error"}>{message}</div>}
        </section>

        {activeJob && <section className="result-section">
          <div className="section-heading"><div><span className="section-kicker">02 / LIVE JOB</span><h2>Your creation</h2></div><span className="job-id">JOB {activeJob.id.slice(0,8).toUpperCase()}</span></div>
          <div className="result-card">
            {activeJob.assetUrl ? (activeJob.kind === "image" ? <Image className="generated-media" src={activeJob.assetUrl} alt="Generated image" width={1600} height={1200} unoptimized/> : <video className="generated-media" src={activeJob.assetUrl} controls playsInline/>) : <div className="result-placeholder"><div className="result-orb"><Sparkles size={24}/></div><b>{activeJob.status === "queued" ? "Waiting in queue" : activeJob.status === "processing" ? "Creating your vision" : activeJob.status === "storage_failed" ? "Storage needs attention" : activeJob.status === "failed" ? "Generation failed" : "Preparing your result"}</b><span>{activeJob.error_message || (["queued","processing","storage_failed"].includes(activeJob.status) ? "Status is being checked against the provider and secure storage. Keep this workspace open." : "The provider completed, but the media file has not been confirmed in storage.")}</span>{["queued","processing"].includes(activeJob.status) && <LoaderCircle className="spin" size={18}/>}</div>}
            <div className="result-details"><div><span className="status-label">{activeJob.status.replace("_"," ")}</span><p>{activeJob.prompt}</p></div>{activeJob.assetUrl && <a className="download-button" href={activeJob.assetUrl} target="_blank" rel="noreferrer">Open file <ArrowUpRight size={15}/></a>}</div>
          </div>
        </section>}

        <section className="library-section" id="library">
          <div className="section-heading"><div><span className="section-kicker">03 / YOUR WORK</span><h2>Recent generations</h2></div><span className="library-count">{jobs.length} records</span></div>
          {visibleJobs.length ? <div className="history-list">{visibleJobs.map((job) => <button className="history-item" key={job.id} onClick={() => setActiveJob(job)}><span className="history-icon">{job.kind === "image" ? <ImageIcon size={18}/> : <Film size={18}/>}</span><span className="history-copy"><b>{job.prompt}</b><small>{new Date(job.created_at).toLocaleString()} · {job.kind}</small></span><span className={job.status === "succeeded" ? "history-status complete" : job.status === "failed" ? "history-status failed" : "history-status"}>{job.status.replace("_"," ")}</span></button>)}</div> : <div className="empty-library"><div><Plus size={20}/></div><b>Your creative history starts here</b><span>Completed and in-progress generations will appear here. No sample work is inserted.</span></div>}
        </section>
        <footer className="app-footer"><span>LUMI AI</span><span>Real models. Real work. No placeholders.</span><span>© 2026</span></footer>
      </div>
    </section>
  </main>;
}
