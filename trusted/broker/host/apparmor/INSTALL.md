# Install the Hone evaluator AppArmor profile

The version-controlled source of truth is
`trusted/broker/host/apparmor/hone-evaluator-cgroup`. The persistent host copy is
`/etc/apparmor.d/hone-evaluator-cgroup`. Loading the repository path directly is
not persistent: the AppArmor service reads the `/etc/apparmor.d` copy after a
service reload or host reboot.

The profile in this revision has SHA-256
`d5a3a8d452b02780e2be40f5bd7e35771e987720974d86f01971493a6c2d5a3a`.
If the source profile changes, update this checksum in the same reviewed commit.

## Install and load

Run this from the root of the landed repository checkout at a maintenance
boundary. These commands intentionally require root and must not be run by a
repository build or test:

```sh
set -eu
repo_profile=trusted/broker/host/apparmor/hone-evaluator-cgroup
installed_profile=/etc/apparmor.d/hone-evaluator-cgroup
expected_sha=d5a3a8d452b02780e2be40f5bd7e35771e987720974d86f01971493a6c2d5a3a

# Refuse to install unexpected repository bytes.
printf '%s  %s\n' "$expected_sha" "$repo_profile" | /usr/bin/sha256sum --check -

# Persist the reviewed source with the normal AppArmor profile ownership/mode.
sudo /usr/bin/install --owner=root --group=root --mode=0644 \
  "$repo_profile" "$installed_profile"

# Prove the installed file is byte-identical to the reviewed repository file.
sudo /usr/bin/cmp --silent "$repo_profile" "$installed_profile"
printf '%s  %s\n' "$expected_sha" "$installed_profile" | \
  sudo /usr/bin/sha256sum --check -

# Compile the installed file itself, bypass every parser cache, and atomically
# replace the loaded profile. A nonzero exit is a failed installation.
sudo /usr/sbin/apparmor_parser --replace --skip-cache --abort-on-error --verbose \
  "$installed_profile"

# Verify that the exact profile name is loaded in enforce mode.
sudo /usr/sbin/aa-status --json | \
  /usr/bin/jq -e '.profiles["hone-evaluator-cgroup"] == "enforce"'
```

Do not use `aa-status` alone as an equality proof: it exposes the loaded profile
name and mode, not a source-policy hash. The proof that the loaded policy equals
the installed policy is the complete chain above:

1. both the repository and installed files hash to the reviewed digest;
2. `cmp` proves those files are byte-identical;
3. `apparmor_parser --replace --skip-cache` exits successfully after compiling
   `/etc/apparmor.d/hone-evaluator-cgroup` as its only profile input, so no stale
   cached policy can be loaded; and
4. `aa-status` confirms that `hone-evaluator-cgroup` is loaded in enforce mode.

Capture the checksum, parser, and `aa-status` output together as the installation
receipt.

## Verify persistence

After evaluator work is quiescent, a service reload is the reboot-equivalent
persistence check because it reloads profiles from `/etc/apparmor.d`, not from
the repository checkout:

```sh
sudo /usr/bin/systemctl reload apparmor.service
printf '%s  %s\n' \
  d5a3a8d452b02780e2be40f5bd7e35771e987720974d86f01971493a6c2d5a3a \
  /etc/apparmor.d/hone-evaluator-cgroup | sudo /usr/bin/sha256sum --check -
sudo /usr/sbin/aa-status --json | \
  /usr/bin/jq -e '.profiles["hone-evaluator-cgroup"] == "enforce"'
```

Repeat the final checksum and `aa-status` checks after the next host reboot. If
any command fails, stop evaluator launches and restore the reviewed installed
file; never compensate by running an evaluator unconfined.
