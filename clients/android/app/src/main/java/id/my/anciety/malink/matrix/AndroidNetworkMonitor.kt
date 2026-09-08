package id.my.anciety.malink.matrix

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities

interface NetworkMonitor {
    fun isAvailable(): Boolean

    fun start(onChanged: (Boolean) -> Unit)

    fun stop()
}

class AndroidNetworkMonitor(context: Context) : NetworkMonitor {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private var callback: ConnectivityManager.NetworkCallback? = null
    private var listener: ((Boolean) -> Unit)? = null
    private var lastValue: Boolean? = null
    private val defaultNetwork = DefaultNetworkAvailability<Network>()

    override fun isAvailable(): Boolean {
        val active = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(active) ?: return false
        // VALIDATED means Android's public-internet probe succeeded; it does
        // not mean the configured Matrix homeserver is reachable. Enterprise
        // networks, VPNs, captive portals, and LAN-hosted homeservers can all
        // lack VALIDATED while Matrix itself is available. Let the SDK's real
        // request and retry path decide endpoint reachability.
        return hasUsableMatrixNetwork(
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
        )
    }

    @Synchronized
    override fun start(onChanged: (Boolean) -> Unit) {
        if (callback != null) return
        listener = onChanged
        lastValue = isAvailable()
        defaultNetwork.reset(manager.activeNetwork)
        callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                defaultNetwork.available(network)
            }

            override fun onLost(network: Network) {
                defaultNetwork.lost(network)?.let(::publish)
            }

            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                defaultNetwork.capabilities(
                    network,
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
                )?.let(::publish)
            }
        }.also(manager::registerDefaultNetworkCallback)
    }

    @Synchronized
    override fun stop() {
        callback?.let { runCatching { manager.unregisterNetworkCallback(it) } }
        callback = null
        listener = null
        lastValue = null
        defaultNetwork.reset(null)
    }

    private fun publish(available: Boolean) {
        val target = synchronized(this) {
            if (lastValue == available) null else {
                lastValue = available
                listener
            }
        }
        target?.invoke(available)
    }
}

/** Use callback facts: querying ConnectivityManager inside a callback can
 * observe the old default network and miss its loss permanently. A late loss
 * or capability update for the old network must not disconnect its replacement.
 */
internal class DefaultNetworkAvailability<T> {
    private var current: T? = null

    @Synchronized fun reset(network: T?) { current = network }
    @Synchronized fun available(network: T) { current = network }
    @Synchronized fun capabilities(network: T, internet: Boolean): Boolean? =
        if (network == current) hasUsableMatrixNetwork(internet) else null
    @Synchronized fun lost(network: T): Boolean? {
        if (network != current) return null
        current = null
        return false
    }
}

internal fun hasUsableMatrixNetwork(hasInternetCapability: Boolean): Boolean =
    hasInternetCapability
