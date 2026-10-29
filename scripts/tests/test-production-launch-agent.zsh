#!/bin/zsh
set -e
SCRIPT_DIR="${0:A:h}"
source "$SCRIPT_DIR/../lib/production-launch-agent.zsh"
typeset -gi calls=0 prints=0
sleep() { :; }
launchctl() {
  if [[ "$1" == "bootstrap" ]];then
    (( calls++ ))
    if (( calls < 3 ));then return 5;fi
    return 0
  fi
  if [[ "$1" == "print" ]];then (( prints++ ));return 5;fi
  return 6
}
owl_launch_agent_bootstrap gui/501 com.owl.runtime /tmp/runtime.plist 3
[[ $calls -eq 3 && $prints -eq 2 ]] || exit 20
calls=0
prints=0
launchctl() {
  if [[ "$1" == "bootstrap" ]];then
    (( calls++ ))
    return 5
  fi
  if [[ "$1" == "print" ]];then
    (( prints++ ))
    return 0
  fi
  return 6
}
owl_launch_agent_bootstrap gui/501 com.owl.runtime /tmp/runtime.plist 3
[[ $calls -eq 1 && $prints -eq 1 ]] || exit 21
calls=0
prints=0
launchctl() {
  if [[ "$1" == "bootstrap" ]];then
    (( calls++ ))
    return 5
  fi
  if [[ "$1" == "print" ]];then
    (( prints++ ))
    return 6
  fi
  return 6
}
if owl_launch_agent_bootstrap gui/501 com.owl.runtime /tmp/runtime.plist 3;then
  echo "FAIL: persistent error incorrectly reported success" >&2
  exit 22
fi
[[ $calls -eq 3 && $prints -eq 3 ]] || exit 23
print "PASS: temporary launchctl EIO retry, already-loaded detection, persistent-error failure"
