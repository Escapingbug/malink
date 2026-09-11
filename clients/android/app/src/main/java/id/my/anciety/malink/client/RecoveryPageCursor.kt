package id.my.anciety.malink.client

/** Each round-robin read continues its target instead of repeating page one. */
internal class RecoveryPageCursor {
    var next: String? = null
        private set
    private val seen = mutableSetOf<String>()

    fun advance(token: String?): Boolean {
        if (token == null) {
            next = null
            seen.clear()
            return false
        }
        check(seen.add(token)) { "History recovery returned a repeated pagination cursor" }
        next = token
        return true
    }
}
