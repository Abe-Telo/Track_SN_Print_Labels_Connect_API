<?php
session_start();
if(isset($_SESSION['logged_in']) && $_SESSION['logged_in'] === true) {
    ?>
    <!-- All your protected HTML content goes here -->
    <h1>Welcome to the Tracking System</h1>
    <button onclick="toggleSection('AddTrackingForm')">Add Tracking</button>
    <button onclick="toggleSection('searchSection')">Search</button>
    <!-- etc. -->
    <?php
} else {
    echo 'You are not authorized to view this page. Please <a href="login.html">login</a>.';
}
?>
