##
## @author diltdicker
## @license MIT
@tool
extends EditorPlugin


func _enter_tree() -> void:
	add_custom_type("PeerToPeerClient", "Node", preload("res://addons/gaming_rtc/p2p_multiplayer.gd"), preload("res://addons/gaming_rtc/gaming_rtc_icon.svg"))


func _exit_tree() -> void:
	remove_custom_type("PeerToPeerClient")
