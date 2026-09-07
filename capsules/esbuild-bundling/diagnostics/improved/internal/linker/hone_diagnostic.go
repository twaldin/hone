package linker

import runtimedebug "runtime/debug"

func init() {
	runtimedebug.SetGCPercent(-1)
}
