# CodeGuard AI

A code reviewer that explains itself. Paste or import a Python, JavaScript, TypeScript or Java file (or open a pull request on a repository with the CodeGuard GitHub App) and CodeGuard combines deterministic static analysis with an LLM to report bugs, security issues and slow spots, explain why they matter, and propose fixes that are re-validated before they count. Student Mode adds plain-language explanations, quizzes built from your own mistakes, and XP, levels and badges.

Live at [cloudtest.tech](https://cloudtest.tech). Next.js 16 (App Router) on Vercel, Supabase (Auth + Postgres via Prisma), Groq and OpenRouter for inference, Resend for email.

- [Architecture](#architecture)
- [Authentication & Email Routing](#authentication--email-routing)
- [Code Review Pipeline](#code-review-pipeline)
- [Data Model](#data-model)
- [Development](#development)

## Architecture

The browser talks to Next.js route handlers and server components on Vercel. Server code reaches Postgres through Prisma, as the table owner. Row-level security protects Supabase's auto-generated REST API: every table has RLS, signed-in users get read-only, owner-scoped policies, and the History page reads through the user's own Supabase session under those policies. Reviews call Groq first and fall back to OpenRouter (zero data retention enforced on every request); if both fail, the review degrades to static-analysis results. The GitHub App drives PR reviews through signed webhooks and also powers "Import from GitHub" in the editor.

```mermaid
flowchart TD
    browser(["Browser<br/>Next.js UI, Monaco editor"])
    github(["GitHub<br/>App webhooks and REST API"])

    subgraph vercel["Vercel: Next.js 16, Node.js functions"]
        proxy["proxy.ts<br/>session refresh, signed-in-only pages"]
        pages["Server components<br/>/history, /dashboard, /reviews/:id"]
        reviewApi["/api/reviews/*<br/>review, fix, improve, export, quiz"]
        authApi["/api/auth/custom-action<br/>/api/auth/email-hook"]
        ghApi["/api/integrations/github/webhook<br/>/api/github/browse"]
        pipeline["Review pipeline<br/>static analysis, LLM, merge, scoring"]
    end

    subgraph supabase["Supabase"]
        sbAuth["Supabase Auth<br/>email + password, GitHub OAuth"]
        postgres[("PostgreSQL<br/>Prisma schema, RLS on every table")]
    end

    subgraph llm["LLM providers"]
        groq["Groq<br/>openai/gpt-oss-120b, primary"]
        openrouter["OpenRouter<br/>Nemotron, ZDR enforced, fallback"]
    end

    resend["Resend<br/>transactional email"]

    browser --> proxy --> pages
    browser -->|"fetch"| reviewApi
    browser -->|"sign-up, password reset"| authApi
    browser -->|"sign-in, GitHub OAuth"| sbAuth
    reviewApi --> pipeline
    ghApi --> pipeline
    pipeline -->|"primary"| groq
    pipeline -.->|"fallback"| openrouter
    vercel ==>|"Prisma, server-side, table owner"| postgres
    pages -.->|"History: user session under RLS"| postgres
    authApi -->|"admin generateLink"| sbAuth
    sbAuth -.->|"Send Email Hook, optional"| authApi
    authApi -->|"send"| resend
    github -->|"signed webhooks"| ghApi
    ghApi -->|"installation token: files, PR review, check run"| github
    sbAuth ---|"auth.users to User, cascade delete"| postgres
```

## Authentication & Email Routing

Sign-in (password or GitHub OAuth) goes straight from the browser to Supabase Auth. Sign-up confirmations and password resets go through `/api/auth/custom-action` instead of Supabase's mailer: the admin API generates the one-time link without sending anything, and Resend delivers it. Because Supabase's email rate limits no longer apply, the endpoint enforces its own and answers the same way whether or not an account exists.

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant F as Sign-up or forgot-password form
    participant API as /api/auth/custom-action
    participant DB as Postgres AuthEmailSend
    participant SA as Supabase Auth admin API
    participant R as Resend API
    participant CB as /auth/callback

    U->>F: Email, plus a password for sign-up
    F->>API: POST type, email, password, next
    API->>API: Validate input, require RESEND_API_KEY
    API->>DB: Count sends in the last hour, per address and type and per IP
    alt Over 3 per address or 10 per IP
        API-->>F: 429 rate_limited
    else Within limits
        API->>DB: Insert row with salted hashes only
        API->>SA: generateLink signup or recovery
        alt Account exists on sign-up, or not found on reset
            SA-->>API: email_exists or user_not_found
            API-->>F: 202 with the same check-your-email message
        else Link generated
            SA-->>API: hashed_token and user
            API-->>F: 202 with the same check-your-email message
            Note over API,R: after() runs once the response is sent, so timing reveals nothing
            opt Sign-up of an unconfirmed address
                API->>SA: updateUserById, the newest password wins
            end
            API->>R: emails.send from noreply@cloudtest.tech with an idempotency key
            R-->>U: Email with a SITE_URL/auth/callback link carrying token_hash, type and next
        end
    end
    U->>CB: Open the link in any browser
    CB->>SA: verifyOtp with token_hash and type
    SA-->>CB: Session
    CB-->>U: Session cookies, redirect to next
```

Notes:

- Links are always built on `SITE_URL` (default `https://cloudtest.tech`), never on the request's `Host` header, so a spoofed host can't redirect a valid token.
- The newest-password rule blocks account pre-hijacking: someone who registers your address first can't keep a password on it once you confirm.
- `/api/auth/email-hook` implements Supabase's Send Email Hook (Standard Webhooks signature check, then Resend). It only matters for emails Supabase itself initiates and is enabled in the Supabase dashboard, not in code.

## Code Review Pipeline

A review starts with deterministic static analysis, which answers within the request (`202`, findings shown immediately) and grounds the LLM: every analyzer finding is passed to the model as evidence it must address. The AI stage runs in the background. Its output is merged with the evidence, every cited line is checked against the source, and fix safety is re-classified before scoring. Fixes never modify the original code; each applied set becomes a new version that is re-analyzed, and only versions that introduce no new issues count as validated.

```mermaid
flowchart LR
    subgraph submit["1. Submission"]
        direction TB
        editor["Editor: paste, upload,<br/>Import from GitHub"]
        pr["GitHub PR webhook<br/>up to 10 changed files"]
    end

    subgraph static["2. Static grounding, in-process"]
        direction TB
        secrets["Secret scan<br/>masks values before storage"]
        linters["Ruff WASM for Python<br/>ESLint + typescript-eslint for JS and TS<br/>java-parser syntax check for Java"]
        patterns["Pattern rules<br/>SQL string building, shell injection,<br/>unsafe deserialization, weak hashes, XSS sinks"]
        metrics["Metrics<br/>complexity, nesting, duplication"]
        dedupe["De-duplicate per line and category<br/>evidence ids S-1 to S-n"]
    end

    subgraph ai["3. AI inference, background"]
        direction TB
        groq["Groq gpt-oss-120b<br/>strict JSON schema"]
        openrouter["OpenRouter Nemotron<br/>ZDR fallback"]
        staticOnly["Static-only report<br/>both providers unavailable"]
    end

    subgraph merge["4. Merge and score"]
        direction TB
        verify["Verify each cited line<br/>against its quoted evidence"]
        safety["Classify fix safety<br/>safe, needs_review, manual_only<br/>demote risky safe fixes"]
        score["Scores"]
    end

    db[("Postgres<br/>Review, Finding, Metrics")]
    prOut["PR review: inline comments on<br/>added lines, plus a check run"]

    subgraph fixes["5. Safe-fix validation loop"]
        direction TB
        select["Apply safe fixes, or an AI<br/>Improve code rewrite"]
        apply["Build a new version<br/>the original never changes"]
        rerun["Re-run full static analysis<br/>on the fixed code"]
        compare{"New issues or<br/>syntax errors?"}
        valid["FixVersion validated = true<br/>XP for fixed findings"]
        invalid["FixVersion validated = false<br/>with validation errors, no XP"]
    end

    %% Node links stay inside their stage so each stage stacks vertically; stages link to each other.
    editor ~~~ pr
    secrets --> linters & patterns & metrics
    linters & patterns & metrics --> dedupe
    groq -->|"rate limits waited out,<br/>schema retries, then failure"| openrouter
    openrouter -->|"failure"| staticOnly
    verify --> safety --> score
    select --> apply --> rerun --> compare
    compare -->|"no"| valid
    compare -->|"yes"| invalid

    submit --> static
    static -->|"static findings, shown at once"| db
    static -->|"masked code + evidence"| ai
    ai -->|"AI findings, or none"| merge
    merge --> db
    db -->|"PR path"| prOut
    db -->|"editor path"| fixes
    fixes -->|"save FixVersion"| db
```

Notes:

- Validation re-runs the static analyzers on the fixed file and compares the findings with the original; no tests are executed. A version that fails is still saved, with its validation errors, so the user can inspect the diff, but it earns no XP.
- PR reviews run in developer mode, review each changed file in full, and comment only on findings on lines the PR added. The check run is `failure` for new critical or high findings, `neutral` for medium, otherwise `success` (or `neutral` if CodeGuard itself fails).
- The same LLM client also generates quizzes (`/api/reviews/:id/quiz`) and Improve Code rewrites.

## Data Model

Core tables from `prisma/schema.prisma`. `User.id` is the Supabase `auth.users` id; that foreign key (cascade delete) is added in `prisma/rls.sql`, so deleting an account removes all of its data. Guest reviews have no user. XP is an append-only ledger, idempotent on `(userId, kind, sourceId)`, from which levels, streaks and badges are derived.

```mermaid
classDiagram
    direction LR

    class SupabaseAuthUser {
        +Uuid id
        +String email
    }
    class User {
        +Uuid id
        +String email
        +String name
        +UserRole role
        +ReviewMode modePreference
    }
    class Review {
        +String id
        +Uuid userId
        +Language language
        +ReviewMode mode
        +ReviewStatus status
        +SourceType sourceType
        +String fileName
        +String originalCode
        +Json scores
        +Boolean staticOnly
        +String model
        +String promptVersion
        +String clientHash
    }
    class Finding {
        +String ref
        +FindingCategory category
        +Severity severity
        +Int startLine
        +Int endLine
        +String fixCode
        +FixSafety fixSafety
        +FindingSource source
        +Float confidence
        +String cwe
        +FindingStatus status
    }
    class FixVersion {
        +FixType type
        +String code
        +List~String~ appliedRefs
        +Boolean validated
        +List~String~ validationErrors
    }
    class Metrics {
        +String reviewId
        +Int loc
        +Int cyclomatic
        +Int nestingDepth
        +Float duplicationPct
        +Json functions
    }
    class Quiz {
        +Json questions
        +String model
    }
    class QuizAttempt {
        +Uuid userId
        +Json answers
        +Int correct
        +Int total
    }
    class XpEvent {
        +XpKind kind
        +String sourceId
        +Int points
    }
    class UserBadge {
        +BadgeCode badge
        +DateTime awardedAt
    }
    class GitHubInstallation {
        +BigInt installationId
        +String accountLogin
        +Uuid userId
    }
    class PullRequestReview {
        +String repo
        +Int prNumber
        +String headSha
        +String status
        +Int commentsPosted
        +BigInt checkRunId
    }
    class AuthEmailSend {
        +String kind
        +String emailHash
        +String clientHash
        +DateTime createdAt
    }

    SupabaseAuthUser "1" -- "0..1" User : same id, cascade delete
    User "0..1" --> "0..*" Review : owns, none for guests
    Review "1" *-- "0..*" Finding
    Review "1" *-- "0..*" FixVersion
    Review "1" *-- "0..1" Metrics
    Review "1" *-- "0..*" Quiz
    Quiz "1" *-- "0..*" QuizAttempt
    User "0..1" --> "0..*" QuizAttempt
    User "1" *-- "0..*" XpEvent
    User "1" *-- "0..*" UserBadge
    User "0..1" --> "0..*" GitHubInstallation : linked, set null
    GitHubInstallation "1" *-- "0..*" PullRequestReview
    PullRequestReview "0..1" --> "0..*" Review : one per changed file

    note for AuthEmailSend "Rate-limit log for /api/auth/custom-action: salted hashes only, no relations, no API grants"
```

Unique keys: `Finding (reviewId, ref)`, `XpEvent (userId, kind, sourceId)`, `UserBadge (userId, badge)`, `PullRequestReview (repo, prNumber, headSha)` (webhook redeliveries are no-ops), `GitHubInstallation.installationId`.

## Development

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

### Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

### Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

### Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
