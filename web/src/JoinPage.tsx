import { useState } from "react";

/** Small copy-to-clipboard button for the command blocks. */
function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked (insecure origin) — user can select manually */
        }
      }}
    >
      {done ? "copied" : "copy"}
    </button>
  );
}

function Command({ cmd }: { cmd: string }) {
  return (
    <div className="codeblock">
      <code className="mono">{cmd}</code>
      <Copy text={cmd} />
    </div>
  );
}

export function JoinPage() {
  // the command targets whatever origin is serving this page, so it is correct
  // for the production site and any self-hosted deployment alike
  const origin = window.location.origin;
  const oneLiner = `curl -fsSL ${origin}/join.sh | sh`;

  return (
    <section className="card join">
      <div className="card-head">
        <h2>become a provider</h2>
        <span className="pill">one command</span>
      </div>
      <p className="hint">
        Offer your machine's CPU and RAM to the market. One command downloads the provider agent, boots a
        sandboxed Golem VM, benchmarks this host, registers a signed offer, and keeps it live with heartbeats
        until you stop it.
      </p>

      <h3 className="label">join now</h3>
      <Command cmd={oneLiner} />
      <p className="hint">
        Runs in your terminal and stays in the foreground — press <span className="mono">Ctrl-C</span> to leave the
        market. Re-running keeps the same provider identity.
      </p>

      <h3 className="label">requirements</h3>
      <ul className="join-list">
        <li>Linux on x86-64.</li>
        <li>
          KVM virtualization enabled and accessible. If you get a <span className="mono">/dev/kvm</span> permission
          error, join the <span className="mono">kvm</span> group and re-login:
          <Command cmd={'sudo usermod -aG kvm "$USER"'} />
        </li>
        <li>
          <span className="mono">curl</span> and <span className="mono">tar</span> on the PATH. No Docker, yagna, or
          Rust toolchain needed — the agent is a single static binary.
        </li>
      </ul>

      <h3 className="label">tuning</h3>
      <p className="hint">
        Set environment variables before the command to size what you offer (defaults: 4 cores, 8&nbsp;GiB). These
        also size the VM the benchmark runs in, so the measured capability matches what you actually commit.
      </p>
      <Command cmd={`CPU_CORES=8 MEM_GIB=16 DISPLAY_NAME=my-node ${oneLiner}`} />

      <h3 className="label">what it does</h3>
      <ol className="join-list">
        <li>Downloads the provider agent to <span className="mono">~/.atlas</span> (checksum-verified).</li>
        <li>
          Fetches the VM runtime and image once (cached in <span className="mono">~/.cache/atlas-vm-driver</span>);
          the image is content-addressed and verified by its hash.
        </li>
        <li>
          Boots a VM with <em>no network interface</em> — the agent's registry traffic leaves the VM only as files,
          which the driver relays here. Everything it signs is signed inside the VM.
        </li>
        <li>Runs the benchmark, obtains an attestation, posts an offer, and heartbeats until you stop it.</li>
      </ol>

      <h3 className="label">advanced</h3>
      <p className="hint">
        Prefer to inspect first? Read the script at{" "}
        <a className="mono" href={`${origin}/join.sh`}>
          {origin}/join.sh
        </a>{" "}
        or download the agent directly from{" "}
        <a className="mono" href={`${origin}/dl/atlas-vm-driver-x86_64-linux`}>
          /dl/atlas-vm-driver-x86_64-linux
        </a>
        . It takes <span className="mono">--help</span> for all options (custom image hash, local runtime, a Docker
        alternative via <span className="mono">agent/manager.py</span>, and more — see the repo's{" "}
        <span className="mono">agent/README.md</span>).
      </p>
    </section>
  );
}
